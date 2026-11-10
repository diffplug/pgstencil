import { test, expect } from 'vitest';
import request from 'supertest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { stableJson } from '../../packages/pgstencil/src/snapshots.ts';
import { createStripeDev } from '../../packages/stripe/src/testing.ts';
import { appMigrations } from '../../examples/better-auth/src/migrations.ts';
import { listen } from '../../examples/better-auth/src/node.ts';
import { bundleDeterministicApp } from '../support/better-auth-bundle.ts';

const origin = 'https://billing.example.test';
const built = bundleDeterministicApp('billing-http-test');
const cookieFrom = (response: request.Response) =>
  ((response.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
    .map((value) => value.split(';')[0])
    .join('; ');

async function fixture() {
  const context = await createTestContext({
    migrations: appMigrations,
    seed: 'billing-http',
  });
  const dev = await createStripeDev(context.time, context.random);
  const app = (await built).createDeterministicApp({
    ...context,
    databaseUrl: context.database.url,
    origin,
    secret: 'pgstencil-billing-test-secret-at-least-32',
    billing: {
      stripe: dev.stripe,
      time: context.time,
      random: context.random,
      config: {
        prices: dev.prices,
        trialDays: 14,
        webhookSecret: dev.webhookSecret,
        live: false,
        redirectOrigins: [dev.origin],
      },
    },
  });
  const server = await listen(app.fetch);
  const client = request(server.origin);
  // Sign in by email code, as a browser on this origin would.
  const csrfResponse = await client.get('/api/auth/csrf').expect(200);
  const csrfCookie = cookieFrom(csrfResponse);
  const signIn = (path: string, body: object) =>
    client
      .post('/api/auth/' + path)
      .set('Origin', origin)
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', csrfResponse.body.csrf as string)
      .send(body);
  await signIn('email-otp/send-verification-otp', {
    email: 'alice@example.test',
    type: 'sign-in',
  }).expect(200);
  const otp = (await context.email.next()).text.match(/\b\d{8}\b/)![0];
  const signedIn = await signIn('sign-in/email-otp', {
    email: 'alice@example.test',
    otp,
  }).expect(200);
  const cookie = cookieFrom(signedIn);
  const post = (path: string, body: object = {}, from = origin) =>
    client
      .post(path)
      .set('Origin', from)
      .set('Cookie', cookie)
      .set('content-type', 'application/json')
      .send(JSON.stringify(body));
  return {
    ...context,
    dev,
    server,
    client,
    cookie,
    post,
    status: (query = '') =>
      client.get('/api/billing' + query).set('Cookie', cookie),
    async close() {
      await server.close();
      await app.close();
      await dev.close();
      await context.close();
    },
  };
}
const httpTest = test.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({}, use) => {
    const f = await fixture();
    try {
      await use(f);
    } finally {
      await f.close();
    }
  },
});

httpTest(
  'billing API: session-owned checkout, raw signed webhook delivery and confirmed return',
  async ({ f }) => {
    const before = (await f.status().expect(200)).body;
    expect(before).toMatchObject({
      access: false,
      trialEligible: true,
      trialDays: 14,
    });
    const started = await f
      .post('/api/billing/checkout', { plan: 'yearly' })
      .expect(200);
    const session = [...f.dev.checkouts.values()][0]!;
    expect(started.body).toEqual({ url: session.url });
    f.dev.completeCheckout(session.id);
    await f.dev.deliver(`${f.server.origin}/api/stripe/webhook`);
    const trial = await f
      .status(`?checkout=${session.metadata!.pgstencil_operation}`)
      .expect(200)
      .expect('cache-control', 'no-store');
    expect(trial.body).toMatchObject({ access: true, plan: 'yearly' });
    await expect(stableJson(trial.body)).toMatchFileSnapshot(
      './snapshots/billing/status.json',
    );
    await expect(
      stableJson(
        f.dev.requests
          .filter((r) => r.method === 'POST')
          .map((r) => ({
            ...r,
            body: Object.fromEntries(
              Object.entries(r.body).map(([key, value]) => [
                key,
                value.replaceAll(origin, '<origin>'),
              ]),
            ),
          })),
      ),
    ).toMatchFileSnapshot('./snapshots/billing/stripe-requests.json');
    const portal = await f.post('/api/billing/portal').expect(200);
    expect(portal.body.url).toContain(f.dev.origin);
    f.email.assertNoUnread();
  },
);

httpTest(
  'billing API rejects anonymous, cross-origin, non-JSON, unknown-plan, forged-return and forged-webhook requests',
  async ({ f }) => {
    await f.client.get('/api/billing').expect(401);
    for (const path of [
      '/api/billing/checkout',
      '/api/billing/portal',
      '/api/billing/cancel-checkout',
    ]) {
      await f.client
        .post(path)
        .set('Origin', origin)
        .set('content-type', 'application/json')
        .send(JSON.stringify({ plan: 'monthly' }))
        .expect(401);
      await f.post(path, { plan: 'monthly' }, 'https://evil.test').expect(403);
      await f
        .post(path, { plan: 'monthly' }, `${origin}.evil.test`)
        .expect(403);
      await f.client
        .post(path)
        .set('Cookie', f.cookie)
        .set('Origin', origin)
        .type('form')
        .send({ plan: 'monthly' })
        .expect(415);
    }
    // No Origin at all, as a non-browser client sends it.
    await f.client
      .post('/api/billing/checkout')
      .set('Cookie', f.cookie)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ plan: 'monthly' }))
      .expect(403);
    await f
      .post('/api/billing/checkout', { plan: 'price_attacker' })
      .expect(400);
    await f.post('/api/billing/checkout', {}).expect(400);
    await f.status('?checkout=forged').expect(404);
    await f.client
      .post('/api/stripe/webhook')
      .send({ id: 'evt_forged' })
      .expect(400);
    await f.client
      .post('/api/stripe/webhook')
      .set('stripe-signature', 'forged')
      .send('{}')
      .expect(400);
    expect(f.dev.checkouts.size).toBe(0);
    expect(f.dev.requests.filter((r) => r.method === 'POST')).toEqual([]);
  },
);

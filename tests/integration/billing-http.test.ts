import { test, expect } from 'vitest';
import request from 'supertest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { defaultMigrations } from '../../packages/pgstencil/src/database.ts';
import {
  captureResponse,
  stableJson,
} from '../../packages/pgstencil/src/snapshots.ts';
import { createStripeDev } from '../../packages/stripe/src/testing.ts';
import { billingMigrations } from '../../packages/stripe/src/migrations.ts';
import { startApp } from '../../examples/login/src/app.ts';
import { begin, cookies, post, field } from './helpers.ts';

async function fixture() {
  const context = await createTestContext({
    migrations: [defaultMigrations, billingMigrations],
  });
  const dev = await createStripeDev(context.time, context.random);
  const app = await startApp({
    databaseUrl: context.database.url,
    time: context.time,
    random: context.random,
    email: context.email,
    development: true,
    secret: 'pgstencil-billing-test-secret-at-least-32',
    billing: {
      stripe: dev.stripe,
      devOrigin: dev.origin,
      config: {
        prices: dev.prices,
        trialDays: 14,
        webhookSecret: dev.webhookSecret,
        live: false,
      },
    },
  });
  const target = {
    client: request.agent(app.origin),
    origin: app.origin,
    email: context.email,
  };
  const flow = await begin(target);
  const signedIn = await post(
    target,
    '/login/code',
    { csrf: flow.csrf, code: flow.code },
    flow.pendingCookie,
  ).expect(303);
  const cookie = cookies(signedIn);
  const account = await target.client
    .get('/account')
    .set('Cookie', cookie)
    .expect(200);
  return {
    ...context,
    dev,
    app,
    target,
    cookie,
    csrf: field(account.text, 'csrf'),
    async close() {
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
  'browser billing flow uses authenticated forms and raw signed webhook delivery',
  async ({ f }) => {
    const page = await request(f.app.origin)
      .get('/billing')
      .set('Cookie', f.cookie)
      .expect(200);
    expect(page.text).toContain('provide a card');
    const started = await post(
      f.target,
      '/billing/checkout',
      { csrf: f.csrf, plan: 'yearly' },
      f.cookie,
    ).expect(303);
    const session = [...f.dev.checkouts.values()][0]!;
    expect(started.headers.location).toBe(session.url);
    f.dev.completeCheckout(session.id);
    await f.dev.deliver(`${f.app.origin}/webhooks/stripe`);
    const trial = await request(f.app.origin)
      .get('/billing')
      .set('Cookie', f.cookie)
      .expect(200);
    const captured = captureResponse(trial, f.app.origin);
    await expect(captured.html).toMatchFileSnapshot(
      './snapshots/billing/page.html',
    );
    await expect(captured.markdown).toMatchFileSnapshot(
      './snapshots/billing/page.md',
    );
    await expect(
      captured.http.replaceAll(f.dev.origin, 'https://stripe.test'),
    ).toMatchFileSnapshot('./snapshots/billing/page-http.json');
    await expect(
      stableJson(
        f.dev.requests
          .filter((r) => r.method === 'POST')
          .map((r) => ({
            ...r,
            body: Object.fromEntries(
              Object.entries(r.body).map(([key, value]) => [
                key,
                value.replaceAll(f.app.origin, '<origin>'),
              ]),
            ),
          })),
      ),
    ).toMatchFileSnapshot('./snapshots/billing/stripe-requests.json');
    const portal = await post(
      f.target,
      '/billing/portal',
      { csrf: f.csrf },
      f.cookie,
    ).expect(303);
    expect(portal.headers.location).toContain(f.dev.origin);
    f.email.assertNoUnread();
  },
);

httpTest(
  'billing HTTP rejects CSRF, anonymous requests, forged returns and malformed webhooks',
  async ({ f }) => {
    await request(f.app.origin)
      .get('/billing')
      .expect(303)
      .expect('location', '/login');
    await post(
      f.target,
      '/billing/checkout',
      { csrf: 'wrong', plan: 'monthly' },
      f.cookie,
    ).expect(403);
    await request(f.app.origin)
      .post('/billing/checkout')
      .set('Cookie', f.cookie)
      .set('Origin', 'https://evil.test')
      .type('form')
      .send({ csrf: f.csrf, plan: 'monthly' })
      .expect(403);
    await post(
      f.target,
      '/billing/checkout',
      { csrf: f.csrf, plan: 'price_attacker' },
      f.cookie,
    ).expect(400);
    await request(f.app.origin)
      .get('/billing?checkout=forged')
      .set('Cookie', f.cookie)
      .expect(404);
    await request(f.app.origin)
      .post('/webhooks/stripe')
      .send({ id: 'evt_forged' })
      .expect(400);
    await request(f.app.origin)
      .post('/webhooks/stripe')
      .set('stripe-signature', 'forged')
      .send('{}')
      .expect(400);
    expect(f.dev.checkouts.size).toBe(0);
  },
);

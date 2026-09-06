import { test, expect } from 'vitest';
import request from 'supertest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { startProduction } from '../../examples/login/src/production.ts';
import { begin, cookies, post } from './helpers.ts';

test('production composition sets hardened cookies, uses real time, and hides local inbox', async ({
  onTestFinished,
}) => {
  const context = await createTestContext();
  onTestFinished(() => context.close());
  const app = await startProduction({
    databaseUrl: context.database.url,
    publicOrigin: 'https://login.example.test',
    secret: 'production-composition-test-secret-only',
    email: context.email,
  });
  onTestFinished(() => app.close());
  await request(app.origin).get('/dev/emails').expect(404);
  // Requests reach the loopback port but must claim the public origin.
  const target = {
    client: request.agent(app.origin),
    origin: app.publicOrigin,
    email: context.email,
  };
  const flow = await begin(target, 'production@example.test');
  const page = flow.login;
  expect(page.text).not.toContain('Local inbox');
  expect(page.headers['set-cookie']![0]).toMatch(/^__Host-pgstencil-pending=/);
  expect(page.headers['set-cookie']![0]).toContain('; Secure');
  expect(page.headers['set-cookie']![0]).not.toContain('Domain=');
  expect(page.headers['referrer-policy']).toBe('strict-origin');
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.headers['content-security-policy']).toContain(
    "form-action 'self'",
  );
  expect(cookies(page)).toBe(flow.pendingCookie);
  expect(flow.message.html).toContain('https://login.example.test/login/link');
  const dbFlow = await app.db
    .selectFrom('login_flows')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(Math.abs(dbFlow.created_at.getTime() - Date.now())).toBeLessThan(
    10000,
  );
  const response = await post(
    target,
    '/login/code',
    { csrf: flow.csrf, code: flow.code },
    flow.pendingCookie,
  ).expect(303);
  const cookie = response.headers['set-cookie']![0]!;
  expect(cookie).toMatch(/^__Host-pgstencil=/);
  expect(cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=86400;');
  expect(cookie).toContain('; Secure');
  const challenge = await app.db
    .selectFrom('login_challenges')
    .selectAll()
    .executeTakeFirstOrThrow();
  const session = await app.db
    .selectFrom('sessions')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(JSON.stringify({ challenge, session })).not.toContain(flow.code);
  expect(session.token_hash).not.toBe(cookie.split(';')[0]!.split('=')[1]);
});

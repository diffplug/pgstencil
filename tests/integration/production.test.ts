import { test, expect } from 'vitest';
import request from 'supertest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { startProduction } from '../../examples/login/src/production.ts';
import { cookies, field } from './helpers.ts';

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
  const page = await request(app.origin).get('/login').expect(200);
  expect(page.text).not.toContain('Local inbox');
  expect(page.headers['set-cookie']![0]).toMatch(/^__Host-pgstencil-pending=/);
  expect(page.headers['set-cookie']![0]).toContain('; Secure');
  expect(page.headers['set-cookie']![0]).not.toContain('Domain=');
  expect(page.headers['referrer-policy']).toBe('strict-origin');
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.headers['content-security-policy']).toContain(
    "form-action 'self'",
  );
  const pending = cookies(page);
  await request(app.origin)
    .post('/login')
    .set('Cookie', pending)
    .set('Origin', app.publicOrigin)
    .type('form')
    .send({ csrf: field(page.text, 'csrf'), email: 'production@example.test' })
    .expect(303);
  const email = await context.email.next();
  expect(email.html).toContain('https://login.example.test/login/link');
  const flow = await app.db
    .selectFrom('login_flows')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(Math.abs(flow.created_at.getTime() - Date.now())).toBeLessThan(10000);
  const code = email.text
    .match(/code is (\d{4}) (\d{4})/)!
    .slice(1)
    .join('');
  const response = await request(app.origin)
    .post('/login/code')
    .set('Cookie', pending)
    .set('Origin', app.publicOrigin)
    .type('form')
    .send({ csrf: field(page.text, 'csrf'), code })
    .expect(303);
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
  expect(JSON.stringify({ challenge, session })).not.toContain(code);
  expect(session.token_hash).not.toBe(cookie.split(';')[0]!.split('=')[1]);
});

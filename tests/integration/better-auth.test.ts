import { test, expect } from 'vitest';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import request from 'supertest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { queryDatabase } from '../../packages/pgstencil/src/postgres.ts';
import {
  captureEmail,
  captureResponse,
  stableJson,
} from '../../packages/pgstencil/src/snapshots.ts';
import { schemaChanges } from '../../examples/better-auth/src/schema.ts';
import { listen } from '../../examples/better-auth/src/node.ts';
import type { createDeterministicApp } from '../support/better-auth-entry.ts';

const origin = 'https://better-auth.example.test';
const migrations = resolve('examples/better-auth/migrations');
const built = (async () => {
  const result = await build({
    entryPoints: ['tests/support/better-auth-entry.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'bundle',
    external: [
      ...builtinModules,
      ...builtinModules.map((name) => `node:${name}`),
      'pg-native',
    ],
    inject: [resolve('tests/support/scoped-globals.ts')],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  await mkdir('.build', { recursive: true });
  const file = resolve('.build/better-auth-test.mjs');
  await writeFile(file, result.outputFiles[0]!.text);
  return (await import(pathToFileURL(file).href)) as {
    createDeterministicApp: typeof createDeterministicApp;
  };
})();
async function fixture(now = '2020-01-01T00:00:00.000Z') {
  const context = await createTestContext({
    migrations,
    now,
    seed: 'better-auth-email',
  });
  const { createDeterministicApp } = await built;
  const app = createDeterministicApp({
    ...context,
    databaseUrl: context.database.url,
    origin,
    secret: 'better-auth-local-test-secret-32-characters',
  });
  const server = await listen(app.fetch);
  const client = request(server.origin);
  const post = (path: string, body: object, cookie = '') =>
    client
      .post('/api/auth/' + path)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(body);
  const get = (cookie = '') =>
    client.get('/api/auth/get-session').set('Cookie', cookie);
  return {
    ...context,
    app,
    server,
    client,
    post,
    get,
    async close() {
      await server.close();
      await app.close();
      await context.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const cookieFrom = (response: request.Response) =>
  (response.headers['set-cookie'] as unknown as string[])
    .map((v) => v.split(';')[0])
    .join('; ');
async function login(f: Fixture) {
  expect(
    (
      await f.post('email-otp/send-verification-otp', {
        email: 'alice@example.test',
        type: 'sign-in',
      })
    ).status,
  ).toBe(200);
  const email = await f.email.next();
  const otp = email.text.match(/\b\d{8}\b/)![0];
  const response = await f.post('sign-in/email-otp', {
    email: 'alice@example.test',
    otp,
  });
  expect(response.status, response.text).toBe(200);
  return { email, otp, response, cookie: cookieFrom(response) };
}

test('Better Auth email: repeatable cookies, database and email snapshots across parallel apps', async ({
  onTestFinished,
}) => {
  const fixtures = await Promise.all([fixture(), fixture()]);
  for (const f of fixtures) onTestFinished(() => f.close());
  expect(fixtures[0]!.server.origin).not.toBe(fixtures[1]!.server.origin);
  const results = await Promise.all(fixtures.map(login));
  expect(results[0]!.email).toEqual(results[1]!.email);
  expect(results[0]!.response.body).toEqual(results[1]!.response.body);
  expect(results[0]!.response.headers['set-cookie']).toEqual(
    results[1]!.response.headers['set-cookie'],
  );
  const rows = await Promise.all(
    fixtures.map((f) =>
      queryDatabase(f.database.url, 'SELECT * FROM "session" ORDER BY id'),
    ),
  );
  expect(rows[0]).toEqual(rows[1]);
  await expect(stableJson(rows[0])).toMatchFileSnapshot(
    './snapshots/better-auth-session.json',
  );
  await expect(captureEmail(results[0]!.email, origin)).toMatchFileSnapshot(
    './snapshots/better-auth-email.md',
  );
  await expect(
    stableJson(results[0]!.response.headers['set-cookie']),
  ).toMatchFileSnapshot('./snapshots/better-auth-cookies.json');
  const page = captureResponse(await fixtures[0]!.client.get('/'), origin);
  await expect(page.html).toMatchFileSnapshot(
    './snapshots/better-auth-login.html',
  );
  await expect(page.markdown).toMatchFileSnapshot(
    './snapshots/better-auth-login.md',
  );
  expect(
    (
      await fixtures[0]!.post('sign-in/email-otp', {
        email: 'alice@example.test',
        otp: results[0]!.otp,
      })
    ).status,
  ).not.toBe(200);
  const plan = await schemaChanges(fixtures[0]!.database.url);
  expect(plan.toBeCreated).toEqual([]);
  expect(plan.toBeAdded).toEqual([]);
  expect(plan.toBeAddedIndexes).toEqual([]);
});

test('Better Auth time: 23 hours, expiration boundary, isolated async contexts and unchanged host clock', async ({
  onTestFinished,
}) => {
  const nativeDate = globalThis.Date;
  const nativeCrypto = globalThis.crypto;
  const a = await fixture(),
    b = await fixture('2030-06-01T00:00:00Z');
  onTestFinished(() => a.close());
  onTestFinished(() => b.close());
  const [alice, other] = await Promise.all([login(a), login(b)]);
  a.time.advanceHours(23);
  expect((await a.get(alice.cookie)).body.user.email).toBe(
    'alice@example.test',
  );
  const [one, two] = await Promise.all([a.app.probe(), b.app.probe()]);
  expect(one.before).toBe(a.time.now().getTime());
  expect(one.after).toBe(one.before);
  expect(two.before).toBe(b.time.now().getTime());
  expect(two.after).toBe(two.before);
  a.time.advanceHours(1);
  // Better Auth 1.7.3 compares expiresAt < now: equality remains valid for one millisecond.
  expect((await a.get(alice.cookie)).body.user.email).toBe(
    'alice@example.test',
  );
  a.time.advanceMilliseconds(1);
  expect((await a.get(alice.cookie)).body).toBeNull();
  expect((await b.get(other.cookie)).body.user.email).toBe(
    'alice@example.test',
  );
  expect(globalThis.Date).toBe(nativeDate);
  expect(globalThis.crypto).toBe(nativeCrypto);
  expect(Date.now()).toBeGreaterThan(Date.parse('2025-01-01'));
});

test('Better Auth email rejects expired codes and cross-origin sign-in', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const send = await f.post('email-otp/send-verification-otp', {
    email: 'alice@example.test',
    type: 'sign-in',
  });
  expect(send.status).toBe(200);
  const otp = (await f.email.next()).text.match(/\b\d{8}\b/)![0];
  f.time.advanceMilliseconds(600_001);
  expect(
    (await f.post('sign-in/email-otp', { email: 'alice@example.test', otp }))
      .status,
  ).not.toBe(200);
  const response = await f.client
    .post('/api/auth/email-otp/send-verification-otp')
    .set('Origin', 'https://attacker.test')
    .set('Cookie', 'browser=test')
    .send({ email: 'alice@example.test', type: 'sign-in' });
  expect(response.status).toBe(403);
  expect(f.email.all()).toHaveLength(1);
});

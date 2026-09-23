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
import { authOptions } from '../../examples/better-auth/src/auth.ts';
import { connectDatabase } from '../../packages/pgstencil/src/postgres.ts';
import { listen } from '../../examples/better-auth/src/node.ts';
import type { createDeterministicApp } from '../support/better-auth-entry.ts';

const origin = 'https://better-auth.example.test';
const migrations = resolve('packages/auth/better-auth-migrations');
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
    inject: [resolve('packages/auth/src/better-auth-testing.ts')],
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
async function fixture(
  now = '2020-01-01T00:00:00.000Z',
  sessionPolicy: 'single' | 'multiple' = 'multiple',
  extra: { ipAddressHeaders?: string[] } = {},
) {
  const context = await createTestContext({
    migrations,
    now,
    seed: 'better-auth-email',
  });
  const { createDeterministicApp } = await built;
  const app = createDeterministicApp({
    ...context,
    sessionPolicy,
    ...extra,
    databaseUrl: context.database.url,
    origin,
    secret: 'better-auth-local-test-secret-32-characters',
  });
  const server = await listen(app.fetch);
  const client = request(server.origin);
  const csrfResponse = await client.get('/api/auth/csrf');
  const csrfCookie = cookieFrom(csrfResponse);
  const csrf = csrfResponse.body.csrf as string;
  const post = (path: string, body: object, cookie = '') =>
    client
      .post('/api/auth/' + path)
      .set('Origin', origin)
      .set('Cookie', [csrfCookie, cookie].filter(Boolean).join('; '))
      .set('X-CSRF-Token', csrf)
      .send(body);
  const get = (cookie = '') =>
    client.get('/api/auth/get-session').set('Cookie', cookie);
  return {
    ...context,
    app,
    server,
    client,
    csrf,
    csrfCookie,
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

/** The binding @hono/node-server passes: the connection a client cannot forge. */
const socket = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress } },
});
async function directPost(
  f: Fixture,
  path: string,
  body: object,
  ip = '192.0.2.1',
  headers: Record<string, string> = {},
) {
  return f.app.fetch(
    new Request(origin + '/api/auth/' + path, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-csrf-token': f.csrf,
        cookie: f.csrfCookie,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    socket(ip),
  );
}

test('email policy: secret-keyed codes, cross-browser redemption, concurrent single use and no token exposure', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  await f
    .post('email-otp/send-verification-otp', {
      email: 'alice@example.test',
      type: 'sign-in',
    })
    .expect(200);
  const otp = (await f.email.next()).text.match(/\b\d{8}\b/)![0];
  const { createHmac, createHash } = await import('node:crypto');
  const [record] = await queryDatabase<{ value: string }>(
    f.database.url,
    'SELECT value FROM verification',
  );
  const expected = createHmac(
    'sha256',
    'better-auth-local-test-secret-32-characters',
  )
    .update('email-otp\0')
    .update(otp)
    .digest('hex');
  expect(record!.value).toBe(expected + ':0');
  expect(record!.value).not.toContain(
    createHash('sha256').update(otp).digest('base64url'),
  );
  // Another browser obtains its own CSRF token; it never receives the sending browser's cookies.
  const other = await f.client.get('/api/auth/csrf');
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      f.app.fetch(
        new Request(origin + '/api/auth/sign-in/email-otp', {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-csrf-token': other.body.csrf,
            cookie: cookieFrom(other),
          },
          body: JSON.stringify({ email: 'alice@example.test', otp }),
        }),
        socket(`192.0.2.${i + 1}`),
      ),
    ),
  );
  expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  const success = responses.find((r) => r.status === 200)!;
  expect(await success.json()).not.toHaveProperty('token');
  const cookie = success.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const session = await f.get(cookie);
  expect(session.body.session).not.toHaveProperty('token');
  const [row] = await queryDatabase<{ token: string }>(
    f.database.url,
    'SELECT token FROM session',
  );
  // DB tokens are not sufficient: a valid server signature is required on cookies.
  expect(
    (await f.get(`__Host-pgstencil.session_token=${row!.token}`)).body,
  ).toBeNull();
  expect(success.headers.getSetCookie()[0]).toMatch(
    /^__Host-pgstencil\.session_token=/,
  );
  expect(success.headers.getSetCookie()[0]).not.toContain('Domain=');
});

test('email policy: distributed IPs cannot bypass cooldown, send quota or attempt budget', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const body = { email: 'limited@example.test', type: 'sign-in' };
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      directPost(
        f,
        'email-otp/send-verification-otp',
        body,
        `192.0.2.${i + 1}`,
      ),
    ),
  );
  expect(burst.filter((r) => r.status === 200)).toHaveLength(1);
  const otp = (await f.email.next()).text.match(/\b\d{8}\b/)![0];
  for (let i = 0; i < 3; i++)
    expect(
      (
        await directPost(
          f,
          'sign-in/email-otp',
          { email: body.email, otp: 'wrong-code' },
          `198.51.100.${i + 1}`,
        )
      ).status,
    ).not.toBe(200);
  expect(
    (
      await directPost(
        f,
        'sign-in/email-otp',
        { email: body.email, otp },
        '198.51.100.9',
      )
    ).status,
  ).not.toBe(200);
  for (let i = 0; i < 4; i++) {
    f.time.advanceMilliseconds(60_000);
    expect(
      (
        await directPost(
          f,
          'email-otp/send-verification-otp',
          body,
          `203.0.113.${i + 1}`,
        )
      ).status,
    ).toBe(200);
  }
  f.time.advanceMilliseconds(60_000);
  expect(
    (
      await directPost(
        f,
        'email-otp/send-verification-otp',
        body,
        '203.0.113.99',
      )
    ).status,
  ).toBe(429);
  f.time.advanceMilliseconds(15 * 60_000);
  expect(
    (
      await directPost(
        f,
        'email-otp/send-verification-otp',
        body,
        '203.0.113.99',
      )
    ).status,
  ).toBe(200);
});

const secret = 'better-auth-local-test-secret-32-characters';
const hmac = async (purpose: string, value: string) =>
  (await import('node:crypto'))
    .createHmac('sha256', secret)
    .update(purpose + '\0')
    .update(value)
    .digest('hex');
const sendStatuses = async (
  count: number,
  send: (email: string, i: number) => Promise<{ status: number }>,
) => {
  const statuses = [];
  for (let i = 0; i < count; i++)
    statuses.push(
      (await send(`ip-${i}-${statuses.length}@example.test`, i)).status,
    );
  return statuses;
};
const sendOtp = { type: 'sign-in' };

test('IP rate limits: stored limiter keys never contain a raw client IP', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  await f
    .post('email-otp/send-verification-otp', {
      email: 'loopback@example.test',
      type: 'sign-in',
    })
    .expect(200);
  expect(
    await sendStatuses(4, (email) =>
      directPost(
        f,
        'email-otp/send-verification-otp',
        { ...sendOtp, email },
        '203.0.113.50',
      ),
    ),
  ).toEqual([200, 200, 200, 429]);
  await directPost(
    f,
    'sign-in/email-otp',
    { email: 'loopback@example.test', otp: '00000000' },
    '2001:db8::77',
  );
  const upstream = await queryDatabase<{ key: string }>(
    f.database.url,
    'SELECT * FROM "rateLimit"',
  );
  const own = await queryDatabase<{ key: string }>(
    f.database.url,
    'SELECT * FROM pgstencil_auth_limits',
  );
  const stored = JSON.stringify([upstream, own]);
  for (const ip of ['203.0.113.50', '2001:db8', '127.0.0.1', '::1'])
    expect(stored).not.toContain(ip);
  expect(upstream.length).toBeGreaterThanOrEqual(3);
  for (const row of upstream) expect(row.key).toMatch(/^[0-9a-f]{64}$/);
  // Both limiters count the same trusted address, each under its own secret-keyed purpose.
  expect(upstream.map((row) => row.key)).toContain(
    await hmac('rate-limit', '203.0.113.50|/email-otp/send-verification-otp'),
  );
  expect(own.map((row) => row.key)).toContain(
    `send:ip:${await hmac('ip-rate', '203.0.113.50')}`,
  );
});

test('IP rate limits: the default Node path counts the socket, so rotating x-pgstencil-client-ip cannot escape', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  // A real @hono/node-server socket: every request arrives from loopback.
  expect(
    await sendStatuses(4, (email, i) =>
      f.client
        .post('/api/auth/email-otp/send-verification-otp')
        .set('Origin', origin)
        .set('Cookie', f.csrfCookie)
        .set('X-CSRF-Token', f.csrf)
        .set('x-pgstencil-client-ip', `198.51.100.${i + 1}`)
        .set('x-forwarded-for', `198.51.100.${i + 1}`)
        .send({ ...sendOtp, email }),
    ),
  ).toEqual([200, 200, 200, 429]);
});

test('IP rate limits: concurrent requests from one address are counted atomically', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const burst = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      directPost(
        f,
        'email-otp/send-verification-otp',
        { ...sendOtp, email: `burst-${i}@example.test` },
        '198.51.100.30',
      ),
    ),
  );
  expect(burst.filter((r) => r.status === 200)).toHaveLength(3);
  expect(burst.filter((r) => r.status === 429)).toHaveLength(5);
});

test('IP rate limits: two IPv6 addresses in one /64 share one send:ip budget', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const neighbours = ['2001:db8:1:2::a', '2001:db8:1:2:ffff:ffff:ffff:b'];
  const send = (ip: string, i: number) =>
    directPost(
      f,
      'email-otp/send-verification-otp',
      { ...sendOtp, email: `v6-${i}@example.test` },
      ip,
    );
  // Better Auth's own /64 limit allows three a minute; stay under it.
  for (let i = 0; i < 30; i++) {
    if (i && i % 3 === 0) f.time.advanceMilliseconds(60_000);
    expect((await send(neighbours[i % 2]!, i)).status).toBe(200);
  }
  f.time.advanceMilliseconds(60_000);
  expect((await send(neighbours[1]!, 30)).status).toBe(429);
  expect((await send('2001:db8:1:3::a', 31)).status).toBe(200);
  const own = await queryDatabase<{ key: string; count: number }>(
    f.database.url,
    "SELECT key, count FROM pgstencil_auth_limits WHERE key LIKE 'send:ip:%'",
  );
  expect(own).toEqual(
    expect.arrayContaining([
      {
        key: `send:ip:${await hmac('ip-rate', '2001:0db8:0001:0002:0000:0000:0000:0000')}`,
        count: 30,
      },
    ]),
  );
});

test("IP rate limits: naming a victim's IP in x-pgstencil-client-ip spends only the caller's budget", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const victim = '203.0.113.9';
  expect(
    await sendStatuses(4, (email) =>
      directPost(
        f,
        'email-otp/send-verification-otp',
        { ...sendOtp, email },
        '198.51.100.7',
        { 'x-pgstencil-client-ip': victim },
      ),
    ),
  ).toEqual([200, 200, 200, 429]);
  expect(
    (
      await directPost(
        f,
        'email-otp/send-verification-otp',
        { ...sendOtp, email: 'victim@example.test' },
        victim,
      )
    ).status,
  ).toBe(200);
});

test('IP rate limits: an explicit ipAddressHeaders opt-in counts the configured header', async ({
  onTestFinished,
}) => {
  const f = await fixture(undefined, undefined, {
    ipAddressHeaders: ['x-real-ip'],
  });
  onTestFinished(() => f.close());
  // Behind the trusted proxy every socket is the proxy's; the header decides.
  expect(
    await sendStatuses(4, (email, i) =>
      directPost(
        f,
        'email-otp/send-verification-otp',
        { ...sendOtp, email },
        '10.0.0.1',
        { 'x-real-ip': `198.51.100.${i + 1}` },
      ),
    ),
  ).toEqual([200, 200, 200, 200]);
  expect(
    await sendStatuses(4, (email, i) =>
      directPost(
        f,
        'email-otp/send-verification-otp',
        { ...sendOtp, email: 'again-' + email },
        '10.0.0.1',
        {
          'x-real-ip': '203.0.113.20',
          'x-pgstencil-client-ip': `192.0.2.${i + 1}`,
        },
      ),
    ),
  ).toEqual([200, 200, 200, 429]);
});

test('email policy: fifteen verification attempts per fifteen minutes stop even the right code from any IP', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const email = 'guessed@example.test';
  const send = (ip: string) =>
    directPost(f, 'email-otp/send-verification-otp', { ...sendOtp, email }, ip);
  const verify = (otp: string, ip: string) =>
    directPost(f, 'sign-in/email-otp', { email, otp }, ip);
  expect((await send('203.0.113.1')).status).toBe(200);
  await f.email.next();
  for (let i = 0; i < 15; i++)
    expect((await verify('00000000', `198.51.100.${i + 1}`)).status).not.toBe(
      429,
    );
  f.time.advanceMilliseconds(60_000);
  expect((await send('203.0.113.2')).status).toBe(200);
  const otp = (await f.email.next()).text.match(/\b\d{8}\b/)![0];
  expect((await verify(otp, '192.0.2.200')).status).toBe(429);
  f.time.advanceMilliseconds(15 * 60_000);
  expect((await send('203.0.113.3')).status).toBe(200);
  const fresh = (await f.email.next()).text.match(/\b\d{8}\b/)![0];
  expect((await verify(fresh, '192.0.2.201')).status).toBe(200);
});

test('auth surface: explicit CSRF, exact origin, security headers and disabled unused endpoints', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const body = { email: 'alice@example.test', type: 'sign-in' };
  await f.client
    .post('/api/auth/email-otp/send-verification-otp')
    .set('Origin', origin)
    .send(body)
    .expect(403);
  await f.client
    .post('/api/auth/email-otp/send-verification-otp')
    .set('Origin', origin)
    .set('Cookie', f.csrfCookie)
    .set('X-CSRF-Token', 'wrong')
    .send(body)
    .expect(403);
  await f.client
    .post('/api/auth/email-otp/send-verification-otp')
    .set('Origin', 'https://sibling.example.test')
    .set('Cookie', f.csrfCookie)
    .set('X-CSRF-Token', f.csrf)
    .send(body)
    .expect(403);
  for (const path of [
    'email-otp/check-verification-otp',
    'email-otp/reset-password',
    'update-user',
    'revoke-sessions',
  ])
    await f.post(path, {}).expect(404);
  const page = await f.client.get('/');
  expect(page.headers['content-security-policy']).toContain(
    "script-src 'self'",
  );
  expect(page.headers['content-security-policy']).toContain(
    "frame-ancestors 'none'",
  );
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.headers['referrer-policy']).toBe('no-referrer');
  const api = await f.client.get('/api/auth/get-session');
  for (const response of [page, api]) {
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  }
  expect(f.email.all()).toHaveLength(0);
});

test('auth surface: an allowlisted write with a non-JSON body answers 415', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  for (const [path, type, body] of [
    [
      'email-otp/send-verification-otp',
      'application/x-www-form-urlencoded',
      'email=alice%40example.test&type=sign-in',
    ],
    [
      'sign-in/email-otp',
      'text/plain',
      '{"email":"alice@example.test","otp":"00000000"}',
    ],
    ['sign-in/social', 'multipart/form-data; boundary=x', '--x--'],
  ] as const)
    await f.client
      .post('/api/auth/' + path)
      .set('Origin', origin)
      .set('Cookie', f.csrfCookie)
      .set('X-CSRF-Token', f.csrf)
      .set('Content-Type', type)
      .send(body)
      .expect(415);
  expect(f.email.all()).toHaveLength(0);
});

test('auth options reject a non-canonical origin, a short secret and off-origin redirect paths', ({
  onTestFinished,
}) => {
  // Validation runs before any query; the pool never connects.
  const database = connectDatabase('postgres://unused.invalid/none');
  onTestFinished(() => database.destroy());
  const base = {
    database,
    origin: 'https://app.example.test',
    secret: 'a'.repeat(32),
    email: { send: async () => {} },
  };
  expect(() => authOptions(base)).not.toThrow();
  for (const origin of [
    'https://APP.example.test',
    'https://app.example.test/',
    'https://app.example.test:443',
    'https://app.example.test/path',
  ])
    expect(() => authOptions({ ...base, origin }), origin).toThrow(
      'canonical origin',
    );
  expect(() => authOptions({ ...base, secret: 'a'.repeat(31) })).toThrow(
    'at least 32 characters',
  );
  for (const path of [
    '//attacker.test/',
    '/\\attacker.test',
    '/\t/attacker.test',
    'https://attacker.test/',
    'relative',
  ]) {
    expect(() => authOptions({ ...base, successPath: path }), path).toThrow(
      'application origin',
    );
    expect(() => authOptions({ ...base, errorPath: path }), path).toThrow(
      'application origin',
    );
  }
  for (const path of ['/', '/profile?tab=1', '/%2F%2Fattacker.test'])
    expect(() =>
      authOptions({ ...base, successPath: path, errorPath: path }),
    ).not.toThrow();
});

for (const policy of ['single', 'multiple'] as const)
  test(`session policy: ${policy}`, async ({ onTestFinished }) => {
    const f = await fixture('2020-01-01T00:00:00Z', policy);
    onTestFinished(() => f.close());
    const first = await login(f);
    f.time.advanceMilliseconds(61_000);
    const second = await login(f);
    expect(first.cookie).not.toBe(second.cookie);
    expect((await f.get(first.cookie)).body !== null).toBe(
      policy === 'multiple',
    );
    expect((await f.get(second.cookie)).body.user.email).toBe(
      'alice@example.test',
    );
    await f.post('sign-out', {}, second.cookie).expect(200);
    expect((await f.get(second.cookie)).body).toBeNull();
    expect((await f.get(first.cookie)).body !== null).toBe(
      policy === 'multiple',
    );
  });

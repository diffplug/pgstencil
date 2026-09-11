import { test, expect } from 'vitest';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as WorkerResponse,
} from 'miniflare';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import type { EmailMessage } from '../../packages/pgstencil/src/email.ts';
import { queryDatabase } from '../../packages/pgstencil/src/postgres.ts';

const origin = 'https://better-auth.example.test';
const bundles = [false, true].map((deterministic) =>
  build({
    entryPoints: [
      deterministic
        ? 'tests/support/better-auth-worker.ts'
        : 'examples/better-auth/src/worker.ts',
    ],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'node',
    conditions: ['workerd', 'worker'],
    external: ['node:*', 'cloudflare:*', 'pg-native'],
    alias: Object.fromEntries(
      builtinModules
        .filter((name) => !name.startsWith('node:'))
        .map((name) => [name, `node:${name}`]),
    ),
    inject: deterministic ? [resolve('tests/support/scoped-globals.ts')] : [],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.js');",
    },
  }),
);

async function fixture(deterministic = true) {
  const context = await createTestContext({
    migrations: resolve('examples/better-auth/migrations'),
  });
  const bundle = await bundles[deterministic ? 1 : 0]!;
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-09-08',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        APP_ORIGIN: origin,
        AUTH_SECRET: 'better-auth-local-test-secret-32-characters',
      },
      hyperdrives: { HYPERDRIVE: context.database.url },
      serviceBindings: {
        EMAIL: async (request) => {
          await context.email.send((await request.json()) as EmailMessage);
          return new WorkerResponse('ok');
        },
      },
    }),
  );
  await worker.ready;
  const post = (path: string, body: object, cookie = '') =>
    worker.dispatchFetch(origin + '/api/auth/' + path, {
      method: 'POST',
      headers: {
        origin,
        'cf-connecting-ip': '192.0.2.1',
        'content-type': 'application/json',
        cookie,
      },
      body: JSON.stringify(body),
    });
  return {
    ...context,
    worker,
    post,
    get: async (cookie: string) =>
      (
        await worker.dispatchFetch(origin + '/api/auth/get-session', {
          headers: { cookie },
        })
      ).json() as Promise<{
        user: { email: string };
        session: { createdAt: string; expiresAt: string };
      } | null>,
    setTime: (time: string) =>
      worker.dispatchFetch(origin + '/__test/time', {
        method: 'POST',
        body: time,
      }),
    async close() {
      await worker.dispose();
      await context.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function login(f: Fixture) {
  expect(
    (
      await f.post('email-otp/send-verification-otp', {
        email: 'worker@example.test',
        type: 'sign-in',
      })
    ).status,
  ).toBe(200);
  const email = await f.email.next();
  const otp = email.text.match(/\b\d{8}\b/)![0];
  const response = await f.post('sign-in/email-otp', {
    email: 'worker@example.test',
    otp,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const cookies = response.headers.getSetCookie();
  return {
    email,
    cookies,
    cookie: cookies.map((value) => value.split(';')[0]).join('; '),
  };
}

test('Better Auth in workerd: deterministic replay, separate clocks, shared database rate limits', async ({
  onTestFinished,
}) => {
  const a = await fixture(),
    b = await fixture();
  onTestFinished(() => a.close());
  onTestFinished(() => b.close());
  const [first, second] = await Promise.all([login(a), login(b)]);
  expect(first.email).toEqual(second.email);
  expect(first.cookies).toEqual(second.cookies);
  const [rowsA, rowsB] = await Promise.all(
    [a, b].map((f) =>
      queryDatabase(f.database.url, 'SELECT * FROM "session" ORDER BY id'),
    ),
  );
  expect(rowsA).toEqual(rowsB);
  await a.setTime('2020-01-01T23:00:00Z');
  expect((await a.get(first.cookie))?.user.email).toBe('worker@example.test');
  await a.setTime('2020-01-02T00:00:00.001Z');
  expect(await a.get(first.cookie)).toBeNull();
  expect((await b.get(second.cookie))?.user.email).toBe('worker@example.test');
  // Each request creates a new Better Auth instance. Rate limits must survive that.
  const sends = [];
  for (let i = 0; i < 4; i++)
    sends.push(
      (
        await a.post('email-otp/send-verification-otp', {
          email: 'limit@example.test',
          type: 'sign-in',
        })
      ).status,
    );
  expect(sends).toEqual([200, 200, 200, 429]);
  const sendFrom = (ip: string, forwarded: string) =>
    a.worker.dispatchFetch(
      origin + '/api/auth/email-otp/send-verification-otp',
      {
        method: 'POST',
        headers: {
          origin,
          'cf-connecting-ip': ip,
          'x-forwarded-for': forwarded,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'limit@example.test', type: 'sign-in' }),
      },
    );
  expect((await sendFrom('192.0.2.1', '192.0.2.99')).status).toBe(429);
  expect((await sendFrom('192.0.2.2', '192.0.2.1')).status).toBe(200);
  expect((await a.worker.dispatchFetch(origin + '/dev/emails')).status).toBe(
    404,
  );
});

test('normal Workers build uses real time and randomness and contains no test clock controls', async ({
  onTestFinished,
}) => {
  const f = await fixture(false);
  onTestFinished(() => f.close());
  const first = await login(f);
  const session = await f.get(first.cookie);
  expect(
    Math.abs(Date.parse(session!.session.createdAt) - Date.now()),
  ).toBeLessThan(10_000);
  expect(
    Date.parse(session!.session.expiresAt) -
      Date.parse(session!.session.createdAt),
  ).toBe(86_400_000);
  const second = await login(f);
  expect(first.cookie).not.toBe(second.cookie);
  expect((await f.setTime('2020-01-01')).status).toBe(404);
  const inputs = Object.keys((await bundles[0]!).metafile!.inputs);
  expect(
    inputs.some(
      (path) =>
        path.includes('scoped-globals') ||
        path.includes('better-auth-worker.ts'),
    ),
  ).toBe(false);
  expect((await f.post('sign-out', {}, second.cookie)).status).toBe(200);
  expect(await f.get(second.cookie)).toBeNull();
});

import { test, expect } from 'vitest';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MiniflareResponse,
} from 'miniflare';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import type { EmailMessage } from '../../packages/pgstencil/src/email.ts';
import {
  allOAuthCredentials,
  endpointPaths,
  mockOAuthServer,
} from '../support/oauth-server.ts';
import { codeFrom } from './helpers.ts';
import type { AuthState } from '../../packages/auth/src/fetch.ts';

const origin = 'https://worker.example.test';
const bundle = build({
  entryPoints: ['tests/support/worker.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  conditions: ['workerd', 'worker'],
  external: ['node:*', 'cloudflare:*'],
  alias: Object.fromEntries(
    builtinModules
      .filter((name) => !name.startsWith('node:'))
      .map((name) => [name, `node:${name}`]),
  ),
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.js');",
  },
});
type WorkerResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;
const cookie = (response: WorkerResponse) =>
  response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
const workerTest = test.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({}, use) => {
    const f = await fixture();
    try {
      await use(f);
    } finally {
      await f.close();
    }
  },
});
async function fixture() {
  const context = await createTestContext();
  const provider = await mockOAuthServer();
  const bindings: Record<string, string> = {
    APP_ORIGIN: origin,
    AUTH_SECRET: 'workers-test-secret-at-least-32-characters',
  };
  for (const [name, credentials] of Object.entries(allOAuthCredentials)) {
    bindings[`${name.toUpperCase()}_CLIENT_ID`] = credentials.clientId;
    bindings[`${name.toUpperCase()}_CLIENT_SECRET`] = credentials.clientSecret;
  }
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: (await bundle).outputFiles![0]!.text,
      compatibilityDate: '2026-09-08',
      compatibilityFlags: ['nodejs_compat'],
      bindings,
      hyperdrives: { HYPERDRIVE: context.database.url },
      async outboundService(req) {
        const url = new URL(req.url);
        if (url.origin === 'https://inbox.test') {
          await context.email.send((await req.json()) as EmailMessage);
          return new MiniflareResponse('ok');
        }
        const path = endpointPaths[url.origin + url.pathname];
        if (!path)
          throw new Error(
            `Unexpected outbound request: ${url.origin}${url.pathname}`,
          );
        const response = await fetch(provider.origin + path + url.search, {
          method: req.method,
          headers: Object.fromEntries(req.headers),
          ...(req.method === 'POST' ? { body: await req.text() } : {}),
        });
        return new MiniflareResponse(await response.arrayBuffer(), {
          status: response.status,
          headers: {
            'content-type':
              response.headers.get('content-type') ?? 'application/json',
          },
        });
      },
    }),
  );
  try {
    await worker.ready;
  } catch (error) {
    await worker.dispose();
    await provider.close();
    await context.close();
    throw error;
  }
  const get = (path: string, cookies = '') =>
    worker.dispatchFetch(origin + path, {
      headers: { cookie: cookies },
      redirect: 'manual',
    });
  const post = (
    path: string,
    csrf: string,
    cookies: string,
    body: unknown = {},
    requestOrigin = origin,
  ) =>
    worker.dispatchFetch(origin + path, {
      method: 'POST',
      headers: {
        origin: requestOrigin,
        cookie: cookies,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  return {
    ...context,
    worker,
    provider,
    get,
    post,
    async close() {
      await worker.dispose();
      await provider.close();
      await context.close();
    },
  };
}
workerTest(
  'real workerd + Postgres: email login, secure cookies, CSRF, exact 24-hour expiry',
  async ({ f }) => {
    const start = await f.get('/api/auth/session');
    expect(start.status).toBe(200);
    const state = (await start.json()) as AuthState;
    const pending = cookie(start);
    expect(
      (
        await f.post(
          '/api/auth/email',
          state.csrf,
          pending,
          { email: 'worker@example.test' },
          'https://attacker.test',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post('/api/auth/email', state.csrf, pending, {
          email: 'worker@example.test',
        })
      ).status,
    ).toBe(200);
    const email = await f.email.next();
    const verified = await f.post('/api/auth/verify', state.csrf, pending, {
      method: 'code',
      value: codeFrom(email),
    });
    expect(verified.status).toBe(200);
    expect(verified.headers.getSetCookie()[0]).toContain(
      'HttpOnly; SameSite=Lax; Max-Age=86400; Expires=Thu, 02 Jan 2020 00:00:00 GMT; Secure',
    );
    const sessionCookie = cookie(verified);
    const session = (await (
      await f.get('/api/auth/session', sessionCookie)
    ).json()) as AuthState;
    expect(session.session?.user.email).toBe('worker@example.test');
    expect(
      (await f.post('/api/auth/logout', 'forged', sessionCookie)).status,
    ).toBe(403);
    await f.worker.dispatchFetch(origin + '/__test/time', {
      method: 'POST',
      body: '2020-01-01T23:00:00Z',
    });
    expect(
      (
        (await (
          await f.get('/api/auth/session', sessionCookie)
        ).json()) as AuthState
      ).session,
    ).not.toBeNull();
    await f.worker.dispatchFetch(origin + '/__test/time', {
      method: 'POST',
      body: '2020-01-02T00:00:00Z',
    });
    expect(
      (
        (await (
          await f.get('/api/auth/session', sessionCookie)
        ).json()) as AuthState
      ).session,
    ).toBeNull();
  },
);
workerTest.for(['google', 'apple', 'facebook'] as const)(
  'real workerd: %s callback, browser binding and replay protection',
  async (provider, { f }) => {
    const start = await f.get('/api/auth/session');
    const state = (await start.json()) as AuthState;
    const started = await f.post(
      `/api/auth/oauth/${provider}/start`,
      state.csrf,
      cookie(start),
    );
    expect(started.status).toBe(200);
    const callback = f.provider.authorize(
      provider,
      new URL(((await started.json()) as { url: string }).url),
    );
    let path = callback.pathname + callback.search;
    if (provider === 'apple') {
      const relay = await f.worker.dispatchFetch(origin + callback.pathname, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://appleid.apple.com',
        },
        body: callback.searchParams.toString(),
        redirect: 'manual',
      });
      expect(relay.status).toBe(303);
      expect(relay.headers.get('referrer-policy')).toBe('no-referrer');
      expect(relay.headers.getSetCookie()).toEqual([]);
      path = relay.headers.get('location')!;
    }
    const unbound = await f.get(path);
    expect(unbound.headers.get('location')).toContain('/login?error=');
    const result = await f.get(path, cookie(started));
    expect(result.headers.get('location')).toBe('/profile');
    expect(
      (
        (await (
          await f.get('/api/auth/session', cookie(result))
        ).json()) as AuthState
      ).session?.user.email,
    ).toBe('oauth@example.test');
    expect(
      (await f.get(path, cookie(started))).headers.get('location'),
    ).toContain('/login?error=');
  },
);

import { test, expect } from 'vitest';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { queryDatabase } from '../../packages/pgstencil/src/postgres.ts';
import {
  mockOAuthServer,
  endpointPaths,
  allOAuthCredentials,
  type GrantOptions,
} from '../support/oauth-server.ts';
import type { createDeterministicApp } from '../support/better-auth-entry.ts';
import {
  providers,
  type Provider,
} from '../../examples/better-auth/src/oauth.ts';

const origin = 'https://auth.example.test';
const built = (async () => {
  const result = await build({
    entryPoints: ['tests/support/better-auth-entry.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    external: [...builtinModules, 'node:*', 'pg-native'],
    inject: [resolve('packages/auth/src/better-auth-testing.ts')],
    banner: {
      js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
  await mkdir('.build', { recursive: true });
  const path = resolve('.build/better-auth-oauth-test.mjs');
  await writeFile(path, result.outputFiles[0]!.text);
  return (await import(pathToFileURL(path).href)) as {
    createDeterministicApp: typeof createDeterministicApp;
  };
})();
async function fixture(policy: 'single' | 'multiple' = 'multiple') {
  const context = await createTestContext({
    migrations: resolve('packages/auth/better-auth-migrations'),
    seed: 'better-auth-oauth',
  });
  const provider = await mockOAuthServer({
    betterAuth: true,
    now: () => context.time.now(),
  });
  const destinations: string[] = [];
  const outboundFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = endpointPaths[url.origin + url.pathname];
    if (!path)
      throw new Error(`Unexpected provider URL: ${url.origin}${url.pathname}`);
    destinations.push(url.origin + url.pathname);
    return fetch(new Request(provider.origin + path + url.search, request));
  };
  const app = (await built).createDeterministicApp({
    ...context,
    databaseUrl: context.database.url,
    origin,
    secret: 'better-auth-local-oauth-secret-32-characters',
    sessionPolicy: policy,
    oauth: allOAuthCredentials,
    outboundFetch,
  });
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(origin + path, init));
  let ip = 0;
  const browser = async () => {
    const csrfResponse = await request('/api/auth/csrf');
    const csrf = ((await csrfResponse.json()) as { csrf: string }).csrf;
    const jar = new Map<string, string>();
    const accept = (response: Response) => {
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const pos = pair!.indexOf('=');
        jar.set(pair!.slice(0, pos), pair!.slice(pos + 1));
      }
      return response;
    };
    accept(csrfResponse);
    const cookie = () =>
      [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    const address = `192.0.2.${++ip}`;
    return {
      jar,
      cookie,
      post: async (path: string, body: object) =>
        accept(
          await request('/api/auth/' + path, {
            method: 'POST',
            headers: {
              origin,
              cookie: cookie(),
              'x-csrf-token': csrf,
              'content-type': 'application/json',
              'x-pgstencil-client-ip': address,
            },
            body: JSON.stringify(body),
          }),
        ),
      get: async (path: string) =>
        accept(await request(path, { headers: { cookie: cookie() } })),
      follow: async (callback: URL) =>
        accept(
          await request(callback.pathname + callback.search, {
            headers: { cookie: cookie() },
          }),
        ),
    };
  };
  return {
    ...context,
    app,
    provider,
    destinations,
    browser,
    request,
    async close() {
      await app.close();
      await provider.close();
      await context.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Browser = Awaited<ReturnType<Fixture['browser']>>;
async function start(browser: Browser, provider: Provider, link = false) {
  const response = await browser.post(link ? 'link-social' : 'sign-in/social', {
    provider,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return new URL(((await response.json()) as { url: string }).url);
}
async function login(
  f: Fixture,
  browser: Browser,
  provider: Provider,
  options: GrantOptions = {},
  link = false,
) {
  const authorization = await start(browser, provider, link);
  const callback = f.provider.authorize(provider, authorization, options);
  return { authorization, callback, response: await browser.follow(callback) };
}
async function session(browser: Browser) {
  return (await (await browser.get('/api/auth/get-session')).json()) as {
    user: { id: string; email: string };
    session: { id: string };
  } | null;
}

for (const provider of providers)
  test(`Better Auth OAuth: ${provider} login, safe token storage and callback replay`, async ({
    onTestFinished,
  }) => {
    const f = await fixture();
    onTestFinished(() => f.close());
    const browser = await f.browser();
    const { response, callback, authorization } = await login(
      f,
      browser,
      provider,
    );
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get('location')).toBe(origin + '/');
    expect((await session(browser))?.user.email).toBe('oauth@example.test');
    if (provider === 'google' || provider === 'github')
      expect(authorization.searchParams.get('code_challenge_method')).toBe(
        'S256',
      );
    if (provider === 'google' || provider === 'apple')
      expect(authorization.searchParams.get('nonce')).toBeTruthy();
    expect((await browser.follow(callback)).headers.get('location')).toContain(
      'error=oauth_failed',
    );
    const rows = await queryDatabase(
      f.database.url,
      'SELECT "providerId", "accessToken", "refreshToken", "idToken" FROM account',
    );
    expect(rows).toEqual([
      {
        providerId: provider,
        accessToken: null,
        refreshToken: null,
        idToken: null,
      },
    ]);
    expect(f.destinations.length).toBeGreaterThan(0);
  });

for (const provider of ['google', 'apple'] as const)
  test(`Better Auth OAuth: ${provider} rejects invalid signed claims`, async ({
    onTestFinished,
  }) => {
    const f = await fixture();
    onTestFinished(() => f.close());
    for (const options of [
      { badSignature: true },
      { verified: false },
      { missingIdToken: true },
      { claims: { aud: 'wrong-client' } },
      { claims: { iss: 'https://attacker.test' } },
      { claims: { exp: 1 } },
      { claims: { nonce: 'wrong' } },
    ] satisfies GrantOptions[]) {
      const browser = await f.browser();
      const { response } = await login(f, browser, provider, options);
      expect(response.headers.get('location')).toContain('error=oauth_failed');
      expect(await session(browser)).toBeNull();
    }
  });

test('Better Auth OAuth: Apple form_post relay, wrong browser, mismatched provider and expired state', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const browser = await f.browser(),
    stranger = await f.browser();
  const authorization = await start(browser, 'apple');
  const callback = f.provider.authorize('apple', authorization);
  const relay = await f.request('/api/auth/callback/apple', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: callback.searchParams,
  });
  expect(relay.headers.get('referrer-policy')).toBe('no-referrer');
  expect(relay.headers.get('cache-control')).toBe('no-store');
  expect(relay.headers.get('content-security-policy')).toContain(
    "frame-ancestors 'none'",
  );
  const relayed = new URL(relay.headers.get('location')!);
  expect(relayed.origin + relayed.pathname).toBe(
    callback.origin + callback.pathname,
  );
  expect(Object.fromEntries(relayed.searchParams)).toEqual(
    Object.fromEntries(callback.searchParams),
  );
  expect((await stranger.follow(callback)).headers.get('location')).toContain(
    'error=oauth_failed',
  );
  const wrong = new URL(callback);
  wrong.pathname = '/api/auth/callback/google';
  expect((await browser.follow(wrong)).headers.get('location')).toContain(
    'error=oauth_failed',
  );
  expect((await browser.follow(callback)).headers.get('location')).toBe(
    origin + '/',
  );
  const another = await f.browser();
  const pending = f.provider.authorize(
    'google',
    await start(another, 'google'),
  );
  f.time.advanceMilliseconds(600_000);
  expect((await another.follow(pending)).headers.get('location')).toContain(
    'error=oauth_failed',
  );
});

test('Better Auth OAuth: email collision requires explicit linking; linking binds to live session', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const browser = await f.browser();
  await browser.post('email-otp/send-verification-otp', {
    email: 'oauth@example.test',
    type: 'sign-in',
  });
  const otp = (await f.email.next()).text.match(/\b\d{8}\b/)![0];
  expect(
    (
      await browser.post('sign-in/email-otp', {
        email: 'oauth@example.test',
        otp,
      })
    ).status,
  ).toBe(200);
  const userId = (await session(browser))!.user.id;
  const other = await f.browser();
  expect(
    (await login(f, other, 'google')).response.headers.get('location'),
  ).toContain('error=oauth_failed');
  expect(await session(other)).toBeNull();
  expect(
    (await login(f, browser, 'google', {}, true)).response.headers.get(
      'location',
    ),
  ).toBe(origin + '/');
  expect(
    (await login(f, other, 'google')).response.headers.get('location'),
  ).toBe(origin + '/');
  expect((await session(other))!.user.id).toBe(userId);
  // Explicit linking also supports Apple's relay address, which differs from the account email.
  expect(
    (
      await login(
        f,
        browser,
        'apple',
        { email: 'relay@privaterelay.appleid.com' },
        true,
      )
    ).response.headers.get('location'),
  ).toBe(origin + '/');
  const callback = f.provider.authorize(
    'github',
    await start(browser, 'github', true),
  );
  await browser.post('sign-out', {});
  expect((await browser.follow(callback)).headers.get('location')).toContain(
    'error=oauth_failed',
  );
  const accounts = await queryDatabase(
    f.database.url,
    'SELECT "providerId" FROM account ORDER BY "providerId"',
  );
  expect(accounts).toEqual([{ providerId: 'apple' }, { providerId: 'google' }]);
});

for (const policy of ['single', 'multiple'] as const)
  test(`Better Auth OAuth: concurrent ${policy} device logins`, async ({
    onTestFinished,
  }) => {
    const f = await fixture(policy);
    onTestFinished(() => f.close());
    const initial = await f.browser();
    await login(f, initial, 'google');
    const browsers = await Promise.all([f.browser(), f.browser()]);
    const pending = await Promise.all(
      browsers.map(async (browser) =>
        f.provider.authorize('google', await start(browser, 'google')),
      ),
    );
    const responses = await Promise.all(
      browsers.map((browser, i) => browser.follow(pending[i]!)),
    );
    expect(responses.map((r) => r.headers.get('location'))).toEqual([
      origin + '/',
      origin + '/',
    ]);
    const sessions = await Promise.all([initial, ...browsers].map(session));
    expect(sessions.filter(Boolean)).toHaveLength(policy === 'single' ? 1 : 3);
  });

test('Better Auth OAuth: concurrent callbacks exchange once and errors contain no provider details', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const browser = await f.browser();
  const callback = f.provider.authorize(
    'google',
    await start(browser, 'google'),
  );
  const cookie = browser.cookie();
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      f.request(callback.pathname + callback.search, { headers: { cookie } }),
    ),
  );
  expect(
    responses.filter(
      (response) => response.headers.get('location') === origin + '/',
    ),
  ).toHaveLength(1);
  expect(
    f.destinations.filter(
      (url) => url === 'https://oauth2.googleapis.com/token',
    ),
  ).toHaveLength(1);
  const other = await f.browser();
  const failed = await login(f, other, 'google', { tokenFailure: true });
  expect(failed.response.headers.get('location')).toBe(
    origin + '/?error=oauth_failed',
  );
  expect(await failed.response.text()).not.toContain('synthetic-secret');
  const cancelled = f.provider.authorize(
    'google',
    await start(other, 'google'),
  );
  cancelled.searchParams.set('error', 'access_denied');
  cancelled.searchParams.set(
    'error_description',
    'synthetic-secret-never-render-this',
  );
  expect((await other.follow(cancelled)).headers.get('location')).toBe(
    origin + '/?error=oauth_failed',
  );
});

test('Better Auth OAuth: missing/unverified email is rejected and provider identities cannot be stolen by linking', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  for (const [provider, options] of [
    ['github', { verified: false }],
    ['facebook', { email: '' }],
  ] as const) {
    const browser = await f.browser();
    expect(
      (await login(f, browser, provider, options)).response.headers.get(
        'location',
      ),
    ).toContain('error=oauth_failed');
    expect(await session(browser)).toBeNull();
  }
  const owner = await f.browser();
  await login(f, owner, 'google');
  const other = await f.browser();
  await login(f, other, 'github', { email: 'other@example.test' });
  expect(
    (await login(f, other, 'google', {}, true)).response.headers.get(
      'location',
    ),
  ).toContain('error=oauth_failed');
  expect((await session(other))!.user.email).toBe('other@example.test');
  f.time.advanceMilliseconds(600_000);
  expect((await owner.post('link-social', { provider: 'apple' })).status).toBe(
    401,
  );
});

test('Better Auth OAuth: caller cannot override callback origin or use direct provider tokens', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const browser = await f.browser();
  expect(
    (
      await browser.post('sign-in/social', {
        provider: 'google',
        idToken: { token: 'untrusted' },
      })
    ).status,
  ).toBe(400);
  const result = await browser.post('sign-in/social', {
    provider: 'google',
    callbackURL: 'https://attacker.test/',
    additionalData: { pgstencilProvider: 'apple' },
  });
  expect(result.status).toBe(200);
  const authorization = new URL(((await result.json()) as { url: string }).url);
  const callback = f.provider.authorize('google', authorization);
  expect((await browser.follow(callback)).headers.get('location')).toBe(
    origin + '/',
  );
});

test('Better Auth OAuth: parallel applications reproduce cookies and session timestamps', async ({
  onTestFinished,
}) => {
  const a = await fixture(),
    b = await fixture();
  onTestFinished(() => a.close());
  onTestFinished(() => b.close());
  const browsers = await Promise.all([a.browser(), b.browser()]);
  const results = await Promise.all([
    login(a, browsers[0]!, 'google'),
    login(b, browsers[1]!, 'google'),
  ]);
  expect(results[0]!.authorization.href).toBe(results[1]!.authorization.href);
  expect(results[0]!.response.headers.getSetCookie()).toEqual(
    results[1]!.response.headers.getSetCookie(),
  );
  const rows = await Promise.all(
    [a, b].map((f) =>
      queryDatabase(f.database.url, 'SELECT * FROM session ORDER BY id'),
    ),
  );
  expect(rows[0]).toEqual(rows[1]);
});

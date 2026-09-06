import { test, expect } from 'vitest';
import request from 'supertest';
import {
  fixture,
  secondApp,
  login,
  post,
  cookies,
  field,
  sessionCookie,
  type Fixture,
  type LoginTarget,
} from './helpers.ts';
import {
  mockOAuthServer,
  oauthCredentials,
  type GrantOptions,
} from '../support/oauth-server.ts';
import type { Provider } from '../../examples/login/src/oauth-providers.ts';
import { CONNECT_FRESH_MS, OAUTH_MS } from '../../examples/login/src/oauth.ts';
import {
  captureResponse,
  stableJson,
} from '../../packages/pgstencil/src/snapshots.ts';

type Mock = Awaited<ReturnType<typeof mockOAuthServer>>;
const oauthTest = test.extend<{ f: Fixture; providerServer: Mock }>({
  providerServer: async ({}, use) => {
    const server = await mockOAuthServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },
  f: async ({ providerServer }, use) => {
    const f = await fixture({
      oauth: oauthCredentials,
      oauthFetch: providerServer.transport,
    });
    try {
      await use(f);
    } finally {
      await f.close();
    }
  },
});
async function start(
  f: LoginTarget,
  provider: Provider = 'google',
  session?: string,
) {
  const page = session
    ? await f.client.get('/account').set('Cookie', session).expect(200)
    : await f.client.get('/login').expect(200);
  const response = await post(
    f,
    `/oauth/${provider}/${session ? 'connect' : 'start'}`,
    { csrf: field(page.text, 'csrf') },
    session ?? cookies(page),
  ).expect(303);
  return {
    page,
    response,
    authorization: new URL(response.headers.location as string),
    cookie: [cookies(response), session].filter(Boolean).join('; '),
  };
}
function callback(f: { app: { origin: string } }, url: URL, cookie?: string) {
  // A fresh client prevents its real-clock cookie jar from obscuring DevTime checks.
  const req = request(f.app.origin).get(url.pathname + url.search);
  return cookie ? req.set('Cookie', cookie) : req;
}
async function signIn(
  f: Fixture,
  server: Mock,
  provider: Provider = 'google',
  options: GrantOptions = {},
) {
  const flow = await start(f, provider);
  const url = server.authorize(provider, flow.authorization, options);
  const response = await callback(f, url, flow.cookie).expect(303);
  return { ...flow, url, response, session: sessionCookie(f, response) };
}

oauthTest.for(['google', 'github'] as const)(
  '%s login snapshots and deterministic session expiry',
  async (provider, { f, providerServer }) => {
    const flow = await start(f, provider);
    const callbackUrl = providerServer.authorize(provider, flow.authorization);
    const response = await callback(f, callbackUrl, flow.cookie).expect(303);
    expect(response.headers.location).toBe('/account');
    const session = sessionCookie(f, response);
    const account = await f.client
      .get('/account')
      .set('Cookie', session)
      .expect(200);
    const loginCapture = captureResponse(flow.page, f.origin);
    const accountCapture = captureResponse(account, f.origin);
    const snapshots = {
      'login.html': loginCapture.html,
      'login.md': loginCapture.markdown,
      'start-http.json': captureResponse(flow.response, f.origin).http,
      'callback-http.json': captureResponse(response, f.origin).http,
      'account.html': accountCapture.html,
      'account.md': accountCapture.markdown,
      'database.json': stableJson({
        users: await f.app.db.selectFrom('users').selectAll().execute(),
        identities: await f.app.db
          .selectFrom('oauth_identities')
          .selectAll()
          .execute(),
        sessions: await f.app.db.selectFrom('sessions').selectAll().execute(),
      }),
    };
    for (const [name, value] of Object.entries(snapshots)) {
      expect(value).not.toContain(encodeURIComponent(f.origin));
      await expect(value).toMatchFileSnapshot(
        `./snapshots/oauth/${provider}/${name}`,
      );
    }
    const stored = await f.app.db
      .selectFrom('oauth_flows')
      .selectAll()
      .executeTakeFirstOrThrow();
    const storedJson = stableJson(stored);
    expect(stored.consumed_at).toEqual(f.time.now());
    expect(storedJson).not.toContain(
      flow.authorization.searchParams.get('state'),
    );
    expect(storedJson).not.toContain(flow.cookie.split('=')[1]);
    expect(stableJson(snapshots)).not.toMatch(
      /test-google-secret|test-github-secret|mock-access-/,
    );
    f.time.advanceHours(23);
    await f.client.get('/account').set('Cookie', session).expect(200);
    f.time.advanceHours(1);
    await f.client.get('/account').set('Cookie', session).expect(303);
    expect(f.email.all()).toEqual([]);
  },
);

oauthTest(
  'start requires the original browser, CSRF, and same-origin POST',
  async ({ f, providerServer }) => {
    const page = await f.client.get('/login').expect(200);
    const body = { csrf: field(page.text, 'csrf') };
    await post(f, '/oauth/google/start', {}, cookies(page)).expect(403);
    await post(f, '/oauth/google/start', body).expect(403);
    await f.client
      .post('/oauth/google/start')
      .set('Origin', 'https://attacker.test')
      .set('Cookie', cookies(page))
      .type('form')
      .send(body)
      .expect(403);
    await f.client.get('/oauth/google/start').expect(404);
    await post(f, '/oauth/google/connect', body, cookies(page)).expect(403);
    expect(providerServer.requests).toEqual([]);
    expect(
      await f.app.db.selectFrom('oauth_flows').selectAll().execute(),
    ).toEqual([]);
  },
);

oauthTest(
  'state, browser binding and provider mismatch fail before token exchange; valid callback claims once',
  async ({ f, providerServer }) => {
    const flow = await start(f);
    const url = providerServer.authorize('google', flow.authorization);
    const wrongState = new URL(url);
    wrongState.searchParams.set('state', 'a'.repeat(43));
    const duplicate = new URL(url);
    duplicate.searchParams.append('state', url.searchParams.get('state')!);
    const wrongProvider = new URL(url);
    wrongProvider.pathname = '/oauth/github/callback';
    for (const invalid of [wrongState, duplicate, wrongProvider])
      await callback(f, invalid, flow.cookie).expect(400);
    await callback(f, url).expect(400);
    await callback(f, url, `${f.app.oauthName}=${'a'.repeat(43)}`).expect(400);
    expect(
      providerServer.requests.filter((r) => r.method === 'POST'),
    ).toHaveLength(0);
    const results = await Promise.all([
      callback(f, url, flow.cookie),
      callback(f, url, flow.cookie),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 400]);
    await callback(f, url, flow.cookie).expect(400);
    expect(
      providerServer.requests.filter((r) => r.method === 'POST'),
    ).toHaveLength(1);
    expect(
      await f.app.db.selectFrom('sessions').selectAll().execute(),
    ).toHaveLength(1);
  },
);

oauthTest.for([OAUTH_MS - 1, OAUTH_MS])(
  'attempt boundary at %i milliseconds',
  async (milliseconds, { f, providerServer }) => {
    const flow = await start(f);
    f.time.advanceMilliseconds(milliseconds);
    await callback(
      f,
      providerServer.authorize('google', flow.authorization),
      flow.cookie,
    ).expect(milliseconds < OAUTH_MS ? 303 : 400);
  },
);

oauthTest(
  'cancellation is consumed and never reflects provider error text',
  async ({ f, providerServer }) => {
    const flow = await start(f);
    const url = providerServer.authorize('google', flow.authorization);
    url.searchParams.delete('code');
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set(
      'error_description',
      '<script>provider-secret</script>',
    );
    const response = await callback(f, url, flow.cookie).expect(400);
    expect(response.text).toContain('Sign-in was not completed');
    expect(response.text).not.toContain('provider-secret');
    expect(response.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    url.searchParams.delete('error');
    url.searchParams.set('code', 'retry');
    await callback(f, url, flow.cookie).expect(400);
    expect(
      providerServer.requests.filter((r) => r.method === 'POST'),
    ).toHaveLength(0);
  },
);

oauthTest.for([
  { provider: 'google', options: { tokenFailure: true }, status: 502 },
  { provider: 'google', options: { badSignature: true }, status: 502 },
  { provider: 'google', options: { verified: false }, status: 403 },
  { provider: 'github', options: { profileFailure: true }, status: 502 },
  { provider: 'github', options: { verified: false }, status: 403 },
] as const)(
  'provider failure creates no user or session: %j',
  async ({ provider, options, status }, { f, providerServer }) => {
    const flow = await start(f, provider);
    const url = providerServer.authorize(provider, flow.authorization, options);
    const response = await callback(f, url, flow.cookie).expect(status);
    expect(response.text).not.toMatch(
      /synthetic-secret|test-google-secret|test-github-secret|mock-access-/,
    );
    await callback(f, url, flow.cookie).expect(400);
    expect(await f.app.db.selectFrom('users').selectAll().execute()).toEqual(
      [],
    );
    expect(await f.app.db.selectFrom('sessions').selectAll().execute()).toEqual(
      [],
    );
  },
);

oauthTest(
  'email collision requires explicit linking, which rotates the session and enables later provider login',
  async ({ f, providerServer }) => {
    const email = await login(f);
    const flow = await start(f);
    const rejected = await callback(
      f,
      providerServer.authorize('google', flow.authorization, {
        email: 'alice@example.test',
      }),
      flow.cookie,
    ).expect(409);
    expect(rejected.text).toContain('Sign in with email or an existing method');
    expect(
      await f.app.db.selectFrom('oauth_identities').selectAll().execute(),
    ).toEqual([]);
    const connect = await start(f, 'google', email.sessionCookie);
    const response = await callback(
      f,
      providerServer.authorize('google', connect.authorization, {
        email: 'alice@example.test',
      }),
      connect.cookie,
    ).expect(303);
    await f.client
      .get('/account')
      .set('Cookie', email.sessionCookie)
      .expect(303);
    const account = await f.client
      .get('/account')
      .set('Cookie', sessionCookie(f, response))
      .expect(200);
    expect(account.text).toContain('Google is connected');
    // Subject remains authoritative if a provider changes the person's email.
    const returning = await signIn(f, providerServer, 'google', {
      email: 'changed@example.test',
    });
    const users = await f.app.db.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe('alice@example.test');
    const loggedIn = await f.client
      .get('/account')
      .set('Cookie', returning.session)
      .expect(200);
    await post(
      f,
      '/logout',
      { csrf: field(loggedIn.text, 'csrf') },
      returning.session,
    ).expect(303);
    await f.client.get('/account').set('Cookie', returning.session).expect(303);
  },
);

oauthTest.for([
  'wrong-email',
  'missing-session',
  'revoked-session',
  'stale-session',
] as const)('connecting rejects %s', async (reason, { f, providerServer }) => {
  const email = await login(f);
  const flow = await start(f, 'github', email.sessionCookie);
  if (reason === 'revoked-session')
    await f.app.auth.logout(email.sessionCookie.split('=')[1]!);
  if (reason === 'stale-session') f.time.advanceMilliseconds(CONNECT_FRESH_MS);
  const cookie =
    reason === 'missing-session' ? flow.cookie.split('; ')[0] : flow.cookie;
  await callback(
    f,
    providerServer.authorize('github', flow.authorization, {
      email:
        reason === 'wrong-email' ? 'other@example.test' : 'alice@example.test',
    }),
    cookie,
  ).expect(reason === 'stale-session' ? 400 : 403);
  expect(
    await f.app.db.selectFrom('oauth_identities').selectAll().execute(),
  ).toEqual([]);
  expect(
    await f.app.db.selectFrom('sessions').selectAll().execute(),
  ).toHaveLength(1);
});

oauthTest(
  'connecting requires recent authentication before leaving the app',
  async ({ f, providerServer }) => {
    const email = await login(f);
    const account = await f.client
      .get('/account')
      .set('Cookie', email.sessionCookie)
      .expect(200);
    f.time.advanceMilliseconds(CONNECT_FRESH_MS);
    await post(
      f,
      '/oauth/google/connect',
      { csrf: field(account.text, 'csrf') },
      email.sessionCookie,
    ).expect(403);
    expect(providerServer.requests).toEqual([]);
  },
);

oauthTest(
  'a linked provider identity cannot move between accounts or replace another identity',
  async ({ f, providerServer }) => {
    await signIn(f, providerServer);
    const email = await login(f);
    const conflict = await start(f, 'google', email.sessionCookie);
    await callback(
      f,
      providerServer.authorize('google', conflict.authorization, {
        email: 'alice@example.test',
      }),
      conflict.cookie,
    ).expect(409);
    const link = await start(f, 'github', email.sessionCookie);
    const linked = await callback(
      f,
      providerServer.authorize('github', link.authorization, {
        email: 'alice@example.test',
      }),
      link.cookie,
    ).expect(303);
    const replacement = await start(f, 'github', sessionCookie(f, linked));
    await callback(
      f,
      providerServer.authorize('github', replacement.authorization, {
        email: 'alice@example.test',
        subject: '999',
      }),
      replacement.cookie,
    ).expect(409);
    const identities = await f.app.db
      .selectFrom('oauth_identities')
      .selectAll()
      .execute();
    expect(identities).toHaveLength(2);
    expect(new Set(identities.map((i) => i.user_id)).size).toBe(2);
  },
);

test('callback can reach a different server instance; HTTPS cookies use production attributes', async ({
  onTestFinished,
}) => {
  const providerServer = await mockOAuthServer();
  onTestFinished(() => providerServer.close());
  const options = {
    oauth: oauthCredentials,
    oauthFetch: providerServer.transport,
    publicOrigin: 'https://login.example.test',
    secureCookies: true,
  };
  const a = await fixture({ ...options, seed: 'oauth-instance-a' });
  onTestFinished(() => a.close());
  const b = await secondApp(a, 'oauth-instance-b', options);
  onTestFinished(() => b.close());
  const flow = await start(a);
  expect(flow.authorization.searchParams.get('redirect_uri')).toBe(
    'https://login.example.test/oauth/google/callback',
  );
  expect(flow.response.headers['set-cookie']?.[0]).toMatch(
    /^__Host-pgstencil-oauth=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Expires=.*; Secure$/,
  );
  const response = await callback(
    b,
    providerServer.authorize('google', flow.authorization),
    flow.cookie,
  ).expect(303);
  const cookie = sessionCookie(a, response);
  await a.client.get('/account').set('Cookie', cookie).expect(200);
  await b.client.get('/account').set('Cookie', cookie).expect(200);
});

oauthTest(
  'provider discovery failure leaves no attempt and can be retried',
  async ({ f, providerServer }) => {
    providerServer.failDiscovery(true);
    const page = await f.client.get('/login').expect(200);
    const response = await post(
      f,
      '/oauth/google/start',
      { csrf: field(page.text, 'csrf') },
      cookies(page),
    ).expect(503);
    expect(response.text).toContain('sign in with email');
    expect(
      await f.app.db.selectFrom('oauth_flows').selectAll().execute(),
    ).toEqual([]);
    providerServer.failDiscovery(false);
    await signIn(f, providerServer);
  },
);

oauthTest(
  'OAuth start rate limits expire using application time',
  async ({ f }) => {
    const page = await f.client.get('/login').expect(200);
    for (let i = 0; i < 30; i++)
      await post(
        f,
        '/oauth/github/start',
        { csrf: field(page.text, 'csrf') },
        cookies(page),
      ).expect(303);
    await post(
      f,
      '/oauth/github/start',
      { csrf: field(page.text, 'csrf') },
      cookies(page),
    ).expect(429);
    f.time.advanceMilliseconds(15 * 60000);
    await start(f, 'github');
  },
);

test('an attempt that expires during token exchange cannot create a session', async ({
  onTestFinished,
}) => {
  const server = await mockOAuthServer();
  onTestFinished(() => server.close());
  const f = await fixture({
    oauth: oauthCredentials,
    oauthFetch: async (input, init) => {
      const response = await server.transport(input, init);
      if (init.method === 'POST') f.time.advanceMilliseconds(OAUTH_MS);
      return response;
    },
  });
  onTestFinished(() => f.close());
  const flow = await start(f);
  await callback(
    f,
    server.authorize('google', flow.authorization),
    flow.cookie,
  ).expect(400);
  expect(await f.app.db.selectFrom('users').selectAll().execute()).toEqual([]);
  expect(await f.app.db.selectFrom('sessions').selectAll().execute()).toEqual(
    [],
  );
});

oauthTest(
  'OAuth login rotates a previous session and concurrent new logins share one identity',
  async ({ f, providerServer }) => {
    const first = await signIn(f, providerServer);
    const a = await start(f);
    const b = await start(f);
    const responses = await Promise.all(
      [a, b].map((flow) =>
        callback(
          f,
          providerServer.authorize('google', flow.authorization),
          `${flow.cookie}; ${first.session}`,
        ).expect(303),
      ),
    );
    expect(sessionCookie(f, responses[0]!)).not.toBe(
      sessionCookie(f, responses[1]!),
    );
    await f.client.get('/account').set('Cookie', first.session).expect(303);
    expect(
      await f.app.db.selectFrom('users').selectAll().execute(),
    ).toHaveLength(1);
    expect(
      await f.app.db.selectFrom('oauth_identities').selectAll().execute(),
    ).toHaveLength(1);
  },
);

test('providers are opt-in and disabled routes perform no network requests', async ({
  onTestFinished,
}) => {
  const providerServer = await mockOAuthServer();
  onTestFinished(() => providerServer.close());
  const f = await fixture({ oauthFetch: providerServer.transport });
  onTestFinished(() => f.close());
  const page = await f.client.get('/login').expect(200);
  expect(page.text).not.toContain('Continue with Google');
  expect(page.text).not.toContain('Continue with GitHub');
  for (const provider of ['google', 'github', 'unknown']) {
    await f.client
      .get(`/oauth/${provider}/callback?code=unused&state=unused`)
      .expect(404);
    await post(
      f,
      `/oauth/${provider}/start`,
      { csrf: field(page.text, 'csrf') },
      cookies(page),
    ).expect(404);
  }
  expect(providerServer.requests).toEqual([]);
});

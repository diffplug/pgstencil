import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, expect } from 'vitest';
import request from 'supertest';
import {
  Auth,
  OAuth,
  OAuthProviders,
  type AuthDB,
} from '../../packages/auth/src/index.ts';
import {
  createAuthHttp,
  HttpError,
  sendJson,
} from '../../packages/auth/src/http.ts';
import { connectDatabase } from '../../packages/pgstencil/src/postgres.ts';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { cookies, codeFrom } from './helpers.ts';
import { mockOAuthServer, oauthCredentials } from '../support/oauth-server.ts';

async function fixture() {
  const context = await createTestContext();
  const db = connectDatabase<AuthDB>(context.database.url);
  const provider = await mockOAuthServer();
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const auth = new Auth({
    db,
    origin,
    ...context,
    secret: 'pgstencil-http-test-secret-at-least-32',
  });
  const http = createAuthHttp({
    auth,
    oauth: new OAuth(
      auth,
      new OAuthProviders(oauthCredentials, provider.transport),
    ),
    secure: false,
  });
  server.on('request', (req, res) => {
    void http
      .handle(req, res)
      .then((handled) => {
        if (!handled) sendJson(res, {}, 404);
      })
      .catch((error) =>
        sendJson(
          res,
          { error: error.message },
          error instanceof HttpError ? error.status : 503,
        ),
      );
  });
  return {
    ...context,
    db,
    provider,
    origin,
    http,
    post(
      path: string,
      csrf: string,
      cookie: string,
      body: Record<string, unknown> = {},
    ) {
      return request(origin)
        .post(`/api/auth/${path}`)
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf)
        .set('Cookie', cookie)
        .send(body);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await provider.close();
      await db.destroy();
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
  'JSON login keeps tokens in HttpOnly cookies and enforces exact expiry and logout CSRF',
  async ({ f }) => {
    const state = await request(f.origin).get('/api/auth/session').expect(200);
    expect(state.body.session).toBeNull();
    const pending = cookies(state);
    await f
      .post('email', 'forged', pending, { email: 'alice@example.test' })
      .expect(403);
    await f
      .post('email', state.body.csrf, pending, { email: 'alice@example.test' })
      .expect(200);
    const email = await f.email.next();
    const result = await f
      .post('verify', state.body.csrf, pending, {
        method: 'code',
        value: codeFrom(email),
      })
      .expect(200);
    expect(result.body).toEqual({ ok: true });
    expect(String(result.headers['set-cookie']?.[0])).toContain(
      'HttpOnly; SameSite=Lax',
    );
    const cookie = cookies(result);
    const session = await request(f.origin)
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(200);
    expect(session.body.session.user.email).toBe('alice@example.test');
    await f.post('logout', 'forged', cookie).expect(403);
    f.time.advanceHours(24);
    expect(
      (await request(f.origin).get('/api/auth/session').set('Cookie', cookie))
        .body.session,
    ).toBeNull();
  },
);

httpTest(
  'link GET never consumes a challenge; only the requesting browser can confirm',
  async ({ f }) => {
    const state = await request(f.origin).get('/api/auth/session').expect(200);
    const cookie = cookies(state);
    await f
      .post('email', state.body.csrf, cookie, { email: 'alice@example.test' })
      .expect(200);
    const email = await f.email.next();
    const link = new URL(email.text.match(/http[^\s]+/)![0]);
    const preview = await request(f.origin)
      .get(link.pathname + link.search)
      .expect(303);
    expect(preview.headers.location).toContain('/login#id=');
    expect(await f.db.selectFrom('sessions').selectAll().execute()).toEqual([]);
    const other = await request(f.origin).get('/api/auth/session');
    const body = {
      method: 'link',
      id: link.searchParams.get('id'),
      value: link.searchParams.get('token'),
    };
    await f.post('verify', other.body.csrf, cookies(other), body).expect(400);
    await f.post('verify', state.body.csrf, cookie, body).expect(200);
  },
);

httpTest(
  'JSON OAuth start and native callback preserve browser binding for Google and GitHub',
  async ({ f }) => {
    for (const provider of ['google', 'github'] as const) {
      const state = await request(f.origin)
        .get('/api/auth/session')
        .expect(200);
      const started = await f
        .post(`oauth/${provider}/start`, state.body.csrf, cookies(state))
        .expect(200);
      const callback = f.provider.authorize(
        provider,
        new URL(started.body.url),
        {
          email: `${provider}@example.test`,
        },
      );
      const unbound = await request(f.origin)
        .get(callback.pathname + callback.search)
        .expect(303);
      expect(unbound.headers.location).toContain('/login?error=');
      const result = await request(f.origin)
        .get(callback.pathname + callback.search)
        .set('Cookie', cookies(started))
        .expect(303);
      expect(result.headers.location).toBe('/profile');
      const loggedIn = await request(f.origin)
        .get('/api/auth/session')
        .set('Cookie', cookies(result));
      expect(loggedIn.body.session.user.email).toBe(`${provider}@example.test`);
      await f.post('logout', loggedIn.body.csrf, cookies(result)).expect(200);
    }
  },
);

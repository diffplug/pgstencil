import { test, expect } from 'vitest';
import request from 'supertest';
import { fixture, begin, login, post, cookies, field } from './helpers.ts';
import {
  captureResponse,
  captureEmail,
  stableJson,
} from '../../packages/pgstencil/src/snapshots.ts';

test('code login snapshots and fixed 24-hour session expiry', async ({
  expect,
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const flow = await login(f);
  const account = await request(f.app.origin)
    .get('/account')
    .set('Cookie', flow.sessionCookie)
    .expect(200);
  const captured = captureResponse(account, f.app.origin);
  await expect(captured.html).toMatchFileSnapshot(
    './snapshots/code/account.html',
  );
  await expect(captured.markdown).toMatchFileSnapshot(
    './snapshots/code/account.md',
  );
  await expect(
    captureResponse(flow.response, f.app.origin).http,
  ).toMatchFileSnapshot('./snapshots/code/login-http.json');
  await expect(captureEmail(flow.message, f.app.origin)).toMatchFileSnapshot(
    './snapshots/code/email.md',
  );
  const users = await f.app.db
    .selectFrom('users')
    .selectAll()
    .orderBy('email')
    .execute();
  const sessions = await f.app.db
    .selectFrom('sessions')
    .selectAll()
    .orderBy('created_at')
    .execute();
  await expect(stableJson({ users, sessions })).toMatchFileSnapshot(
    './snapshots/code/database.json',
  );
  f.time.advanceHours(23);
  await request(f.app.origin)
    .get('/account')
    .set('Cookie', flow.sessionCookie)
    .expect(200);
  f.time.advanceHours(1);
  const expired = await request(f.app.origin)
    .get('/account')
    .set('Cookie', flow.sessionCookie)
    .expect(303);
  expect(expired.headers.location).toBe('/login');
  expect(expired.headers['set-cookie']?.[0]).toContain('Max-Age=0');
  f.email.assertNoUnread();
});

test('link preview does not consume; only requesting browser can confirm', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const flow = await begin(f);
  const path = flow.link.pathname + flow.link.search;
  const other = await request(f.app.origin).get(path).expect(200);
  expect(other.text).toContain('Open your original browser');
  const preview = await f.client
    .get(path)
    .set('Cookie', flow.pendingCookie)
    .expect(200);
  expect(preview.text).toContain('Confirm sign-in');
  expect(await f.app.db.selectFrom('sessions').selectAll().execute()).toEqual(
    [],
  );
  await post(
    f,
    '/login/link',
    {
      csrf: flow.csrf,
      id: flow.link.searchParams.get('id')!,
      token: flow.link.searchParams.get('token')!,
    },
    flow.pendingCookie,
  ).expect(303);
  await post(
    f,
    '/login/code',
    { csrf: flow.csrf, code: flow.code },
    flow.pendingCookie,
  ).expect(403);
});

test('wrong codes commit attempt counts and exhaust the challenge', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const flow = await begin(f);
  for (let i = 0; i < 5; i++)
    await post(
      f,
      '/login/code',
      { csrf: flow.csrf, code: 'wrong' },
      flow.pendingCookie,
    ).expect(400);
  const challenge = await f.app.db
    .selectFrom('login_challenges')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(challenge.attempts).toBe(5);
  expect(challenge.invalidated_at).not.toBeNull();
  await post(
    f,
    '/login/code',
    { csrf: flow.csrf, code: flow.code },
    flow.pendingCookie,
  ).expect(400);
  expect(await f.app.db.selectFrom('sessions').selectAll().execute()).toEqual(
    [],
  );
});

test.for(['code', 'link'] as const)(
  '%s expires exactly at ten minutes',
  async (method, { onTestFinished }) => {
    const f = await fixture();
    onTestFinished(() => f.close());
    const flow = await begin(f);
    f.time.advanceMilliseconds(600000);
    await post(
      f,
      `/login/${method}`,
      {
        csrf: flow.csrf,
        code: flow.code,
        id: flow.link.searchParams.get('id')!,
        token: flow.link.searchParams.get('token')!,
      },
      flow.pendingCookie,
    ).expect(400);
  },
);

test('concurrent code and link redemption produces exactly one session', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const flow = await begin(f);
  const results = await Promise.all([
    post(
      f,
      '/login/code',
      { csrf: flow.csrf, code: flow.code },
      flow.pendingCookie,
    ),
    post(
      f,
      '/login/link',
      {
        csrf: flow.csrf,
        id: flow.link.searchParams.get('id')!,
        token: flow.link.searchParams.get('token')!,
      },
      flow.pendingCookie,
    ),
  ]);
  expect(results.filter((r) => r.status === 303)).toHaveLength(1);
  expect(
    await f.app.db.selectFrom('sessions').selectAll().execute(),
  ).toHaveLength(1);
});

test('resend cooldown and replacement invalidate old secrets', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const flow = await begin(f);
  await post(
    f,
    '/login/resend',
    { csrf: flow.csrf },
    flow.pendingCookie,
  ).expect(429);
  f.time.advanceMilliseconds(60000);
  await post(
    f,
    '/login/resend',
    { csrf: flow.csrf },
    flow.pendingCookie,
  ).expect(303);
  const mail = await f.email.next();
  await post(
    f,
    '/login/code',
    { csrf: flow.csrf, code: flow.code },
    flow.pendingCookie,
  ).expect(400);
  const code = mail.text
    .match(/code is (\d{4}) (\d{4})/)!
    .slice(1)
    .join('');
  await post(
    f,
    '/login/code',
    { csrf: flow.csrf, code },
    flow.pendingCookie,
  ).expect(303);
});

test('logout revokes replay and rejects missing CSRF', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const flow = await login(f);
  await post(f, '/logout', {}, flow.sessionCookie).expect(403);
  const account = await request(f.app.origin)
    .get('/account')
    .set('Cookie', flow.sessionCookie)
    .expect(200);
  await post(
    f,
    '/logout',
    { csrf: field(account.text, 'csrf') },
    flow.sessionCookie,
  ).expect(303);
  await request(f.app.origin)
    .get('/account')
    .set('Cookie', flow.sessionCookie)
    .expect(303);
});

test('origin, CSRF and browser binding reject forged requests', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const flow = await begin(f);
  await f.client
    .post('/login/code')
    .set('Origin', 'https://evil.example')
    .type('form')
    .send({ csrf: flow.csrf, code: flow.code })
    .expect(403);
  await post(
    f,
    '/login/code',
    { csrf: 'wrong', code: flow.code },
    flow.pendingCookie,
  ).expect(403);
  await request(f.app.origin)
    .post('/login/code')
    .set('Origin', f.app.origin)
    .type('form')
    .send({ csrf: flow.csrf, code: flow.code })
    .expect(403);
});

test('failed email delivery leaves an unusable challenge', async ({
  onTestFinished,
}) => {
  const f = await fixture({
    email: {
      async send() {
        throw new Error('provider unavailable');
      },
    },
  });
  onTestFinished(() => f.close());
  const start = await f.client.get('/login');
  await post(
    f,
    '/login',
    { csrf: field(start.text, 'csrf'), email: 'alice@example.test' },
    cookies(start),
  ).expect(503);
  const challenge = await f.app.db
    .selectFrom('login_challenges')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(challenge.delivered_at).toBeNull();
  expect(challenge.invalidated_at).not.toBeNull();
});

test('a returning user gets a fresh session and the previous token is revoked', async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(() => f.close());
  const first = await login(f);
  const second = await begin(f, ' ALICE@EXAMPLE.TEST ');
  const response = await post(
    f,
    '/login/code',
    { csrf: second.csrf, code: second.code },
    `${second.pendingCookie}; ${first.sessionCookie}`,
  ).expect(303);
  expect(cookies(response)).not.toContain(first.sessionCookie);
  expect(await f.app.db.selectFrom('users').selectAll().execute()).toHaveLength(
    1,
  );
  await request(f.app.origin)
    .get('/account')
    .set('Cookie', first.sessionCookie)
    .expect(303);
  const sessions = await f.app.db.selectFrom('sessions').selectAll().execute();
  expect(sessions).toHaveLength(2);
  expect(sessions.filter((s) => s.revoked_at !== null)).toHaveLength(1);
});

test('send limits aggregate across browsers and server instances', async ({
  onTestFinished,
}) => {
  const a = await fixture({ seed: 'instance-a' });
  const b = await fixture({ seed: 'instance-b', databaseUrl: a.database.url });
  onTestFinished(async () => {
    await b.close();
    await a.close();
  });
  for (let i = 0; i < 5; i++) await begin(i % 2 ? a : b);
  const page = await a.client.get('/login').expect(200);
  await post(
    a,
    '/login',
    { csrf: field(page.text, 'csrf'), email: 'alice@example.test' },
    cookies(page),
  ).expect(429);
  expect(a.email.all().length + b.email.all().length).toBe(5);
  a.time.advanceMilliseconds(15 * 60000);
  await begin(a);
});

test.for(['code', 'link'] as const)(
  '%s works just before expiry and cannot replay',
  async (method, { onTestFinished }) => {
    const f = await fixture();
    onTestFinished(() => f.close());
    const flow = await begin(f);
    f.time.advanceMilliseconds(599999);
    const body = {
      csrf: flow.csrf,
      code: flow.code,
      id: flow.link.searchParams.get('id')!,
      token: flow.link.searchParams.get('token')!,
    };
    await post(f, `/login/${method}`, body, flow.pendingCookie).expect(303);
    await post(f, `/login/${method}`, body, flow.pendingCookie).expect(403);
  },
);

import request from 'supertest';
import {
  DevRandom,
  DevTime,
  EmailDev,
} from '../../packages/pgstencil/src/index.ts';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { startApp, type AppConfig } from '../../examples/login/src/app.ts';
import type {
  CapturedEmail,
  EmailSender,
} from '../../packages/pgstencil/src/email.ts';
const SECRET = 'pgstencil-test-secret-at-least-32-characters';
/**
 * What driving a login flow actually needs: somewhere to send requests, the
 * Origin those requests claim, and the inbox that receives the mail. Both a
 * full fixture and a bare second app instance satisfy it.
 */
export interface LoginTarget {
  client: request.Agent;
  origin: string;
  email: { next(timeoutMs?: number): Promise<CapturedEmail> };
}
type AppOptions = Pick<
  AppConfig,
  'oauth' | 'oauthFetch' | 'publicOrigin' | 'secureCookies'
>;
export async function fixture(
  options: { seed?: string; email?: EmailSender } & AppOptions = {},
) {
  const context = await createTestContext(
    options.seed ? { seed: options.seed } : {},
  );
  try {
    const app = await startApp({
      databaseUrl: context.database.url,
      time: context.time,
      random: context.random,
      email: options.email ?? context.email,
      devInbox: context.email,
      secret: SECRET,
      development: true,
      ...appOptions(options),
    });
    return {
      ...context,
      app,
      client: request.agent(app.origin),
      origin: app.publicOrigin,
      async close() {
        await app.close();
        await context.close();
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
/**
 * A second server on an existing database, for proving that state shared
 * through Postgres is shared. It borrows the database, so it leases nothing.
 */
export async function secondApp(
  f: Fixture,
  seed: string,
  options: AppOptions = {},
) {
  const time = new DevTime();
  const random = new DevRandom(seed);
  const email = new EmailDev(time);
  const app = await startApp({
    databaseUrl: f.database.url,
    time,
    random,
    email,
    devInbox: email,
    secret: SECRET,
    development: true,
    ...options,
  });
  return {
    app,
    time,
    random,
    email,
    client: request.agent(app.origin),
    origin: app.publicOrigin,
    async close() {
      await app.close();
      email.close();
    },
  };
}
function appOptions({
  oauth,
  oauthFetch,
  publicOrigin,
  secureCookies,
}: AppOptions): AppOptions {
  return {
    ...(oauth === undefined ? {} : { oauth }),
    ...(oauthFetch === undefined ? {} : { oauthFetch }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(secureCookies === undefined ? {} : { secureCookies }),
  };
}
export function field(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`Missing field ${name}`);
  return match[1]!;
}
export function cookies(response: request.Response): string {
  const header = response.headers['set-cookie'] as string[] | undefined;
  return (header ?? []).map((value) => value.split(';')[0]).join('; ');
}
/** The sign-in email prints the code in two groups; tests want the digits. */
export function codeFrom(message: { text: string }): string {
  const match = message.text.match(/code is (\d{4}) (\d{4})/);
  if (!match) throw new Error('No sign-in code in email');
  return match.slice(1).join('');
}
export function post(
  target: LoginTarget,
  path: string,
  body: Record<string, string>,
  cookie?: string,
) {
  const req = target.client
    .post(path)
    .set('origin', target.origin)
    .type('form')
    .send(body);
  if (cookie) req.set('Cookie', cookie);
  return req;
}
export async function begin(target: LoginTarget, email = 'alice@example.test') {
  const login = await target.client.get('/login').expect(200);
  const csrf = field(login.text, 'csrf');
  const pendingCookie = cookies(login);
  await post(target, '/login', { csrf, email }, pendingCookie).expect(303);
  const message = await target.email.next();
  const link = new URL(
    message.html.match(/href="([^"]+)"/)![1]!.replaceAll('&amp;', '&'),
  );
  return { csrf, pendingCookie, message, code: codeFrom(message), link, login };
}
export async function login(f: Fixture) {
  const flow = await begin(f);
  const response = await post(
    f,
    '/login/code',
    { csrf: flow.csrf, code: flow.code },
    flow.pendingCookie,
  ).expect(303);
  return {
    ...flow,
    response,
    sessionCookie: cookies(response)
      .split('; ')
      .find((c) => c.startsWith(`${f.app.sessionName}=`))!,
  };
}

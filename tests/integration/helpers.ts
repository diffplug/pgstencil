import request from 'supertest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { startApp } from '../../examples/login/src/app.ts';
import type { EmailSender } from '../../packages/pgstencil/src/email.ts';
export async function fixture(
  options: { seed?: string; email?: EmailSender; databaseUrl?: string } = {},
) {
  const context = await createTestContext(
    options.seed ? { seed: options.seed } : {},
  );
  try {
    const app = await startApp({
      databaseUrl: options.databaseUrl ?? context.database.url,
      time: context.time,
      random: context.random,
      email: options.email ?? context.email,
      secret: 'pgstencil-test-secret-at-least-32-characters',
      development: true,
    });
    return {
      ...context,
      app,
      client: request.agent(app.origin),
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
export function field(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`Missing field ${name}`);
  return match[1]!;
}
export function cookies(response: request.Response): string {
  const header = response.headers['set-cookie'] as unknown as
    string[] | undefined;
  return (header ?? []).map((value) => value.split(';')[0]).join('; ');
}
export function post(
  f: Fixture,
  path: string,
  body: Record<string, string>,
  cookie?: string,
) {
  const req = f.client
    .post(path)
    .set('origin', f.app.origin)
    .type('form')
    .send(body);
  if (cookie) req.set('Cookie', cookie);
  return req;
}
export async function begin(f: Fixture, email = 'alice@example.test') {
  const login = await f.client.get('/login').expect(200);
  const csrf = field(login.text, 'csrf');
  const pendingCookie = cookies(login);
  await post(f, '/login', { csrf, email }, pendingCookie).expect(303);
  const message = await f.email.next();
  const code = message.text
    .match(/code is (\d{4}) (\d{4})/)!
    .slice(1)
    .join('');
  const link = new URL(
    message.html.match(/href="([^"]+)"/)![1]!.replaceAll('&amp;', '&'),
  );
  return { csrf, pendingCookie, message, code, link, login };
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

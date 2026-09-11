import { fileURLToPath } from 'node:url';
import { EmailDev, SystemTime } from 'pgstencil';
import { allocateDatabase } from 'pgstencil/database';
import { createEmailApp } from './auth.ts';
import { listen } from './node.ts';
import { html } from 'hono/html';
import { oauthFromEnvironment } from './oauth.ts';

// A disposable lease keeps this experiment separate from the existing dev database.
const database = await allocateDatabase(
  fileURLToPath(new URL('../migrations', import.meta.url)),
);
const email = new EmailDev(new SystemTime());
let app: ReturnType<typeof createEmailApp> | undefined;
const server = await listen(
  async (request) => {
    if (new URL(request.url).pathname === '/dev/emails')
      return new Response(
        await html`<!doctype html>
          <html lang="en">
            <meta charset="utf-8" /><title>Local inbox</title>
            <main>
              <h1>Local inbox</h1>
              ${email.all().map(
                (mail) =>
                  html`<article>
                    <h2>${mail.subject}</h2>
                    <p>${mail.to.join(', ')}</p>
                    <pre>${mail.text}</pre>
                  </article>`,
              )}<a href="/">Back to sign in</a>
            </main>
          </html>`,
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy':
              "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          },
        },
      );
    return app
      ? app.app.fetch(request)
      : new Response('Starting', { status: 503 });
  },
  Number(process.env.PORT ?? 8082),
);
app = createEmailApp({
  databaseUrl: database.url,
  email,
  oauth: oauthFromEnvironment(process.env),
  sessionPolicy:
    process.env.SESSION_POLICY === 'single' ? 'single' : 'multiple',
  origin: server.origin,
  secret: 'better-auth-local-development-secret-only',
});
console.log(
  `Better Auth: ${server.origin}\nLocal email: ${server.origin}/dev/emails\nDisposable database; restarting starts fresh.`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void (async () => {
      await server.close();
      await app?.close();
      email.close();
      await database.close();
    })().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DevRandom, EmailDev, SystemTime } from 'pgstencil';
import { developmentDatabase, stateDirectory } from 'pgstencil/database';
import { createStripeDev } from '@pgstencil/stripe/testing';
import { html } from 'hono/html';
import { createEmailApp } from './auth.ts';
import { appMigrations } from './migrations.ts';
import { listen } from './node.ts';
import { oauthFromEnvironment } from './oauth.ts';

const port = Number(process.env.PORT ?? 8082);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('PORT must be an integer from 0 to 65535');
// Better Auth reads the real clock, so billing and the inbox use it too.
const time = new SystemTime();
// The development database survives restarts; a fresh seed avoids reusing IDs.
const random = new DevRandom(process.env.PGSTENCIL_SEED ?? randomUUID());
const databaseUrl = await developmentDatabase(true, appMigrations);
const email = new EmailDev(time);
const stripeDev = await createStripeDev(
  time,
  random,
  join(stateDirectory, 'stripe-dev.json'),
);
let app: ReturnType<typeof createEmailApp> | undefined;
const server = await listen(async (request, env) => {
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
    ? app.app.fetch(request, env)
    : new Response('Starting', { status: 503 });
}, port);
app = createEmailApp({
  databaseUrl,
  email,
  oauth: oauthFromEnvironment(process.env),
  sessionPolicy:
    process.env.SESSION_POLICY === 'single' ? 'single' : 'multiple',
  origin: server.origin,
  secret: 'better-auth-local-development-secret-only',
  billing: {
    stripe: stripeDev.stripe,
    time,
    random,
    config: {
      prices: stripeDev.prices,
      trialDays: 14,
      webhookSecret: stripeDev.webhookSecret,
      live: false,
      // Checkout is served by the local simulator.
      redirectOrigins: [stripeDev.origin],
    },
  },
});
stripeDev.setWebhookTarget(`${server.origin}/api/stripe/webhook`);
console.log(
  `pgstencil: ${server.origin}\nLocal inbox: ${server.origin}/dev/emails\nBilling: ${server.origin}/billing`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void (async () => {
      await server.close();
      await app?.close();
      await stripeDev.close();
      email.close();
    })().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });

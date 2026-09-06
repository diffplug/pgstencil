import { DevTime, SystemTime, DevRandom, EmailDev } from 'pgstencil';
import { randomUUID } from 'node:crypto';
import { developmentDatabase } from 'pgstencil/database';
import { startApp } from './app.ts';
import { oauthFromEnvironment } from './oauth-providers.ts';
const oauth = oauthFromEnvironment(process.env);
const publicOrigin = process.env.PUBLIC_ORIGIN;
const port = Number(process.env.PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('PORT must be an integer from 0 to 65535');
if (Object.keys(oauth).length && (!publicOrigin || port === 0))
  throw new Error(
    'Set PUBLIC_ORIGIN and PORT to the origin registered with your OAuth providers',
  );
// Browsers use their own clock for cookies. Historical dates belong in the
// tests, which explicitly replay cookies to exercise server-side expiration.
const time = process.env.PGSTENCIL_TIME
  ? new DevTime(process.env.PGSTENCIL_TIME)
  : new SystemTime();
// The development database survives restarts; a fresh seed avoids reusing IDs.
const random = new DevRandom(process.env.PGSTENCIL_SEED ?? randomUUID());
const email = new EmailDev(time);
const app = await startApp({
  databaseUrl: await developmentDatabase(),
  time,
  random,
  email,
  devInbox: email,
  secret: 'pgstencil-local-development-secret-only',
  development: true,
  port,
  oauth,
  ...(publicOrigin ? { publicOrigin } : {}),
});
console.log(
  `pgstencil: ${app.origin}\nLocal inbox: ${app.origin}/dev/emails\nServer time: ${time.now().toISOString()}`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close().then(() => {
      email.close();
      process.exit(0);
    });
  });

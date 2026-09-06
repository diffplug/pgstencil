import { DevTime, DevRandom, EmailDev } from 'pgstencil';
import { developmentDatabase } from 'pgstencil/database';
import { startApp } from './app.ts';
const time = new DevTime(process.env.PGSTENCIL_TIME ?? '2020-01-01T00:00:00Z');
const random = new DevRandom(process.env.PGSTENCIL_SEED ?? 'pgstencil-dev');
const email = new EmailDev(time);
const app = await startApp({
  databaseUrl: await developmentDatabase(),
  time,
  random,
  email,
  secret: 'pgstencil-local-development-secret-only',
  development: true,
  port: Number(process.env.PORT ?? 0),
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

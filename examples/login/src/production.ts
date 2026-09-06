import { SecureRandom, SystemTime, type EmailSender } from 'pgstencil';
import { startApp } from './app.ts';

/** Compose a real deployment behind an HTTPS reverse proxy. */
export function startProduction(config: {
  databaseUrl: string;
  publicOrigin: string;
  secret: string;
  email: EmailSender;
  port?: number;
}) {
  return startApp({
    ...config,
    time: new SystemTime(),
    random: new SecureRandom(),
    development: false,
    secureCookies: true,
  });
}

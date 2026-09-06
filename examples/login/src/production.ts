import { SecureRandom, SystemTime, type EmailSender } from 'pgstencil';
import { startApp, type AppConfig } from './app.ts';
import type { OAuthSettings } from './oauth-providers.ts';

/** Compose a real deployment behind an HTTPS reverse proxy. */
export function startProduction(config: {
  databaseUrl: string;
  publicOrigin: string;
  secret: string;
  email: EmailSender;
  port?: number;
  oauth?: OAuthSettings;
  billing?: NonNullable<AppConfig['billing']>;
}) {
  return startApp({
    ...config,
    time: new SystemTime(),
    random: new SecureRandom(),
    development: false,
    secureCookies: true,
  });
}

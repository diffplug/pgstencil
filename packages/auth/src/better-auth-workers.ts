import { Hono } from 'hono';
import type { EmailSender } from 'pgstencil';
import { createAuthApp, type AuthAppOptions } from './better-auth.ts';
import {
  oauthFromEnvironment,
  providers,
  type Provider,
} from './better-auth-oauth.ts';

export type BetterAuthWorkerBindings = {
  HYPERDRIVE: { connectionString: string };
  APP_ORIGIN: string;
  AUTH_SECRET: string;
} & Partial<
  Record<
    `${Uppercase<Provider>}_CLIENT_ID` | `${Uppercase<Provider>}_CLIENT_SECRET`,
    string
  >
>;

/** Only the request owns its pool; no sockets or test controls cross invocations. */
export function createBetterAuthWorker<E extends BetterAuthWorkerBindings>(
  options: Pick<
    AuthAppOptions,
    'sessionPolicy' | 'accountLinking' | 'appName' | 'successPath' | 'errorPath'
  > & {
    email: (env: E) => EmailSender;
  },
) {
  const app = new Hono<{ Bindings: E }>();
  app.all('*', async (c) => {
    if (new URL(c.env.APP_ORIGIN).protocol !== 'https:')
      throw new Error('Workers auth requires HTTPS');
    const credentials: Record<string, string> = {};
    for (const provider of providers)
      for (const suffix of ['CLIENT_ID', 'CLIENT_SECRET']) {
        const key = `${provider.toUpperCase()}_${suffix}`;
        const value = c.env[key as keyof E];
        if (typeof value === 'string') credentials[key] = value;
      }
    const auth = createAuthApp({
      ...options,
      databaseUrl: c.env.HYPERDRIVE.connectionString,
      origin: c.env.APP_ORIGIN,
      secret: c.env.AUTH_SECRET,
      email: options.email(c.env),
      oauth: oauthFromEnvironment(credentials),
      ipAddressHeaders: ['cf-connecting-ip'],
    });
    try {
      return await auth.app.fetch(c.req.raw);
    } finally {
      await auth.close();
    }
  });
  app.onError((_, c) =>
    c.json(
      { message: 'Sign-in is temporarily unavailable. Please try again.' },
      503,
      { 'cache-control': 'no-store' },
    ),
  );
  return app;
}

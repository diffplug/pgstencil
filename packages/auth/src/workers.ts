import { Hono } from 'hono';
import {
  SecureRandom,
  SystemTime,
  type EmailSender,
  type Time,
  type RandomSource,
} from 'pgstencil';
import { connectDatabase } from 'pgstencil/postgres';
import { Auth } from './auth.ts';
import type { loginEmail } from './email.ts';
import type { DB } from './db.generated.ts';
import { OAuth } from './oauth.ts';
import {
  OAuthProviders,
  PROVIDERS,
  oauthFromEnvironment,
  type Provider,
  type OAuthFetch,
} from './oauth-providers.ts';
import { createAuthFetch } from './fetch.ts';
import { createAuthHono, type AuthFetch } from './hono.ts';

export type AuthWorkerBindings = {
  HYPERDRIVE: { connectionString: string };
  APP_ORIGIN: string;
  AUTH_SECRET: string;
} & Partial<
  Record<
    `${Uppercase<Provider>}_CLIENT_ID` | `${Uppercase<Provider>}_CLIENT_SECRET`,
    string
  >
>;

/** Request-scoped database connections: never share sockets across Worker invocations. */
export function createAuthWorker<E extends AuthWorkerBindings>(options: {
  email: (env: E) => EmailSender;
  loginPath?: string;
  accountPath?: string;
  renderEmail?: typeof loginEmail;
  /** Injection points belong in a separate test entrypoint, never public HTTP controls. */
  time?: Time;
  random?: RandomSource;
  oauthFetch?: OAuthFetch;
}) {
  type Environment = { Bindings: E; Variables: { auth: AuthFetch } };
  const app = new Hono<Environment>();
  app.use('*', async (c, next) => {
    const env = c.env;
    if (new URL(env.APP_ORIGIN).protocol !== 'https:')
      throw new Error('Workers auth requires an HTTPS application origin');
    const db = connectDatabase<DB>(env.HYPERDRIVE.connectionString);
    try {
      const auth = new Auth({
        db,
        origin: env.APP_ORIGIN,
        secret: env.AUTH_SECRET,
        time: options.time ?? new SystemTime(),
        random: options.random ?? new SecureRandom(),
        email: options.email(env),
        ...(options.renderEmail ? { renderEmail: options.renderEmail } : {}),
      });
      const credentials: Record<string, string | undefined> = {};
      for (const provider of PROVIDERS)
        for (const suffix of ['CLIENT_ID', 'CLIENT_SECRET'] as const) {
          const key =
            `${provider.toUpperCase()}_${suffix}` as keyof AuthWorkerBindings;
          const value = env[key];
          if (typeof value === 'string') credentials[key] = value;
        }
      c.set(
        'auth',
        createAuthFetch({
          auth,
          oauth: new OAuth(
            auth,
            new OAuthProviders(
              oauthFromEnvironment(credentials),
              options.oauthFetch,
            ),
          ),
          secure: true,
          ...(options.loginPath ? { loginPath: options.loginPath } : {}),
          ...(options.accountPath ? { accountPath: options.accountPath } : {}),
          // Cloudflare overwrites this header on inbound requests.
          clientAddress: (req) =>
            req.headers.get('cf-connecting-ip') ?? 'unknown',
        }),
      );
      await next();
    } finally {
      await db.destroy();
    }
  });
  app.route(
    '/',
    createAuthHono<Environment>((c) => c.get('auth')),
  );
  app.onError(
    () =>
      new Response(
        JSON.stringify({
          error: 'Sign-in is temporarily unavailable. Please try again.',
        }),
        {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        },
      ),
  );
  return app;
}

import {
  diagnostic,
  diagnosticError,
  observeRequest,
} from 'pgstencil/diagnostics';
import { Hono } from 'hono';
import type { EmailSender } from 'pgstencil';
import {
  createAuthApp,
  type AuthAppOptions,
  type AuthHooks,
} from './better-auth.ts';
import { authSecurityHeaders } from './better-auth-security.ts';
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
    | 'diagnostics'
    | 'sessionPolicy'
    | 'accountLinking'
    | 'trustedEmailProviders'
    | 'allowMissingEmail'
    | 'rememberLoginMethod'
    | 'appName'
    | 'renderEmail'
    | 'successPath'
    | 'errorPath'
  > & {
    email: (env: E) => EmailSender;
    /**
     * The default sign-in email's sender, usually read from a binding such as
     * `(env) => env.EMAIL_FROM`. When omitted, `undefined` or blank, it is
     * `signin@<hostname of APP_ORIGIN>`. `renderEmail` receives it as `from`.
     */
    emailFrom?: string | ((env: E) => string);
    /** Builds this request's hooks; their pending work is kept alive with `waitUntil`. */
    hooks?: (env: E) => AuthHooks;
  },
) {
  const app = new Hono<{ Bindings: E }>();
  // Setup, teardown and diagnostics can return errors outside the inner app.
  app.use('*', authSecurityHeaders);
  app.all('*', async (c) => {
    const handle = async () => {
      if (new URL(c.env.APP_ORIGIN).protocol !== 'https:')
        throw new Error('Workers auth requires HTTPS');
      const credentials: Record<string, string> = {};
      for (const provider of providers)
        for (const suffix of ['CLIENT_ID', 'CLIENT_SECRET']) {
          const key = `${provider.toUpperCase()}_${suffix}`;
          const value = c.env[key as keyof E];
          if (typeof value === 'string') credentials[key] = value;
        }
      let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
      try {
        const context = c.executionCtx;
        waitUntil = (promise) => context.waitUntil(promise);
      } catch {
        // Hono throws when the caller passed no ExecutionContext.
      }
      let hooks: AuthHooks | undefined;
      try {
        hooks = options.hooks?.(c.env);
      } catch (error) {
        // A broken hook factory must not take sign-in down with it.
        diagnostic('auth.hook.failed', {
          reason: 'unexpected_error',
          ...diagnosticError(error),
        });
      }
      const { hooks: _factory, emailFrom: _from, ...rest } = options;
      const emailFrom =
        typeof options.emailFrom === 'function'
          ? options.emailFrom(c.env)
          : options.emailFrom;
      const auth = createAuthApp({
        ...rest,
        ...(emailFrom === undefined ? {} : { emailFrom }),
        ...(hooks ? { hooks } : {}),
        ...(waitUntil ? { waitUntil } : {}),
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
    };
    return options.diagnostics
      ? observeRequest(c.req.raw, options.diagnostics, handle)
      : handle();
  });
  app.onError((error, c) => {
    diagnostic('request.failed', {
      reason: 'unexpected_error',
      ...diagnosticError(error),
    });
    return c.json(
      { message: 'Sign-in is temporarily unavailable. Please try again.' },
      503,
      { 'cache-control': 'no-store' },
    );
  });
  return app;
}

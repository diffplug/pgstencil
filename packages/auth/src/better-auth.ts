import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { Hono } from 'hono';
import { connectDatabase } from 'pgstencil/postgres';
import type { EmailSender } from 'pgstencil';
import {
  keyed,
  protectAuth,
  publicAuthResponse,
} from './better-auth-security.ts';
import {
  socialProviders,
  verifiedOidc,
  oauthRequest,
  type OAuthSettings,
} from './better-auth-oauth.ts';

export interface AuthOptions {
  database: ReturnType<typeof connectDatabase>;
  origin: string;
  secret: string;
  email: EmailSender;
  ipAddressHeaders?: string[];
  sessionPolicy?: 'single' | 'multiple';
  oauth?: OAuthSettings;
  appName?: string;
  successPath?: string;
  errorPath?: string;
}

export type AuthAppOptions = Omit<AuthOptions, 'database'> & {
  databaseUrl: string;
};

export function authOptions(options: AuthOptions): BetterAuthOptions {
  if (new URL(options.origin).origin !== options.origin)
    throw new Error('Auth requires a canonical origin');
  if (options.secret.length < 32)
    throw new Error('Auth secret must contain at least 32 characters');
  for (const path of [options.successPath ?? '/', options.errorPath ?? '/']) {
    if (
      !path.startsWith('/') ||
      new URL(path, options.origin).origin !== options.origin
    )
      throw new Error(
        'Auth redirect paths must stay on the application origin',
      );
  }
  const secure = options.origin.startsWith('https:');
  return {
    appName: options.appName ?? 'pgstencil',
    baseURL: options.origin,
    secret: options.secret,
    database: { db: options.database, type: 'postgres', transaction: true },
    telemetry: { enabled: false },
    logger: { disabled: true },
    socialProviders: socialProviders(options.oauth),
    onAPIError: { errorURL: options.origin + (options.errorPath ?? '/') },
    user: {
      validateUserInfo: async ({ user, source }) => {
        if (
          source.method === 'oauth' &&
          (user.emailVerified !== true ||
            typeof user.email !== 'string' ||
            !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user.email))
        )
          return { error: 'A verified email address is required' };
      },
    },
    // Keep production security enabled under NODE_ENV=test as well.
    advanced: {
      // SQL is verified before deployment; avoid background introspection racing
      // a request-scoped Worker pool's teardown.
      database: { validateSchema: false },
      useSecureCookies: false, // Names below carry __Host- themselves; avoid a second prefix.
      cookiePrefix: secure ? '__Host-pgstencil' : 'pgstencil',
      defaultCookieAttributes: {
        secure,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: {
        ipAddressHeaders: options.ipAddressHeaders ?? ['x-pgstencil-client-ip'],
      },
    },
    // Workers are request-scoped; an in-memory limiter would reset every request.
    rateLimit: { enabled: true, storage: 'database' },
    session: {
      additionalFields: {
        singleSession: {
          type: 'boolean',
          required: true,
          defaultValue: false,
          input: false,
          returned: false,
        },
      },
      freshAge: 10 * 60,
      expiresIn: 24 * 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
            },
          }),
        },
        update: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
            },
          }),
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              singleSession: options.sessionPolicy === 'single',
            },
          }),
        },
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: 'database',
      accountLinking: {
        disableImplicitLinking: true,
        allowDifferentEmails: true,
      },
    },
    plugins: [
      verifiedOidc,
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: {
          hash: async (otp) => keyed(options.secret, 'email-otp', otp),
        },
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in')
            throw new Error('This example only supports sign-in email');
          await options.email.send({
            from: 'signin@example.test',
            to: [email],
            subject: options.appName
              ? `Your ${options.appName} sign-in code`
              : 'Your sign-in code',
            text: `Your sign-in code is ${otp}. It expires in 10 minutes.`,
            html: `<p>Your sign-in code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
          });
        },
      }),
    ],
  };
}

export function createAuthApp(options: AuthAppOptions) {
  const db = connectDatabase(options.databaseUrl);
  const auth = betterAuth(authOptions({ ...options, database: db }));
  const app = new Hono();
  protectAuth(app, { ...options, database: db });
  app.on(['POST', 'GET'], '/api/auth/*', async (c) =>
    publicAuthResponse(
      await oauthRequest(c.req.raw, auth, { ...options, database: db }),
    ),
  );
  app.get('/api/providers', (c) => c.json(Object.keys(options.oauth ?? {})));
  app.onError((_error, c) =>
    c.json({ message: 'Authentication failed; please try again' }, 500),
  );
  return {
    app,
    auth,
    db,
    close: async () => {
      try {
        await auth.$context;
      } finally {
        await db.destroy();
      }
    },
  };
}

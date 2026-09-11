import {
  diagnostic,
  diagnosticError,
  observeRequest,
  requestOperation,
  type DiagnosticOptions,
} from 'pgstencil/diagnostics';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getSessionFromCtx, isAPIError } from 'better-auth/api';
import { lastLoginMethod } from 'better-auth/plugins';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { Hono } from 'hono';
import { sql } from 'kysely';
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
  type Provider,
} from './better-auth-oauth.ts';

import {
  identityEmail,
  isIdentityEmail,
  providerSubject,
} from './better-auth-email.ts';

export interface AuthOptions {
  database: ReturnType<typeof connectDatabase>;
  diagnostics?: DiagnosticOptions;
  origin: string;
  secret: string;
  email: EmailSender;
  ipAddressHeaders?: string[];
  sessionPolicy?: 'single' | 'multiple';
  accountLinking?: 'explicit' | 'same-email';
  /** Accept these providers' verified email assertions without a local email code. */
  trustedEmailProviders?: Provider[];
  /** Permit provider-only accounts; their public session email is null. */
  allowMissingEmail?: boolean;
  /** Remember the last successful method in a readable, non-authenticating 30-day cookie. */
  rememberLoginMethod?: boolean;
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
    socialProviders: socialProviders(options.oauth, options.allowMissingEmail),
    onAPIError: {
      errorURL: options.origin + (options.errorPath ?? '/'),
      onError: (error) => {
        // Expected 4xx responses are recorded by auth.rejected after dispatch.
        if (isAPIError(error) && error.statusCode < 500) return;
        diagnostic('request.failed', {
          reason: 'unexpected_error',
          ...diagnosticError(error),
        });
      },
    },
    user: {
      validateUserInfo: async ({ user, source }, context) => {
        if (typeof user.email === 'string' && isIdentityEmail(user.email)) {
          const provider = source.oauth?.providerId as Provider;
          const profile = source.oauth?.profile;
          if (
            options.allowMissingEmail &&
            source.method === 'oauth' &&
            options.oauth?.[provider] &&
            user.emailVerified === false &&
            user.email ===
              identityEmail(
                provider,
                options.oauth[provider].clientId,
                providerSubject(provider, profile),
              )
          )
            return;
          diagnostic('auth.oauth.failed', {
            provider,
            stage: 'profile',
            reason: 'reserved_email',
          });
          return { error: 'Reserved email address' };
        }
        if (
          source.method === 'oauth' &&
          (user.emailVerified !== true ||
            typeof user.email !== 'string' ||
            !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user.email))
        ) {
          diagnostic('auth.oauth.failed', {
            provider: source.oauth?.providerId as Provider,
            stage: 'profile',
            reason: 'unverified_email',
          });
          return { error: 'A verified email address is required' };
        }
        if (
          options.accountLinking === 'same-email' &&
          source.method === 'oauth' &&
          source.action !== 'sign-in'
        ) {
          const email = user.email?.toLowerCase() ?? '';
          const profile = source.oauth?.profile;
          const authoritative =
            options.trustedEmailProviders?.includes(
              source.oauth?.providerId as Provider,
            ) ||
            source.oauth?.providerId === 'apple' ||
            (source.oauth?.providerId === 'google' &&
              (email.endsWith('@gmail.com') ||
                (typeof profile?.hd === 'string' && profile.hd.length > 0)));
          if (!authoritative) {
            // An email OTP proves current ownership where the provider cannot.
            // Only the still-live session created by that OTP can supply proof.
            const proof = await getSessionFromCtx(context);
            if (
              !proof ||
              proof.user.email.toLowerCase() !== email ||
              Date.now() - proof.session.createdAt.getTime() >= 600_000 ||
              !(
                await sql`SELECT id FROM session WHERE id = ${proof.session.id} AND "emailAuthenticated" = true AND "expiresAt" > ${new Date()}`.execute(
                  options.database,
                )
              ).rows.length
            ) {
              diagnostic('auth.oauth.failed', {
                provider: source.oauth?.providerId as Provider,
                stage: 'profile',
                reason: 'mailbox_proof_required',
              });
              return { error: 'email_verification_required' };
            }
          }
        }
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
        emailAuthenticated: {
          type: 'boolean',
          required: true,
          defaultValue: false,
          input: false,
          returned: false,
        },
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
          before: async (session, context) => ({
            data: {
              ...session,
              singleSession: options.sessionPolicy === 'single',
              emailAuthenticated: context?.path === '/sign-in/email-otp',
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
        disableImplicitLinking: options.accountLinking !== 'same-email',
        allowDifferentEmails: options.accountLinking !== 'same-email',
      },
    },
    plugins: [
      verifiedOidc,
      ...(options.rememberLoginMethod
        ? [
            lastLoginMethod({
              cookieName: secure
                ? '__Host-pgstencil.last_login_method'
                : 'pgstencil.last_login_method',
              storeInDatabase: false,
              customResolveMethod: (context) =>
                context.path === '/sign-in/email-otp' ? 'email' : null,
              // Do not record failed callbacks, cookie clearing, or explicit linking.
              beforeStoreCookie: (context) => !!context.context.newSession,
            }),
          ]
        : []),
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: {
          hash: async (otp) => keyed(options.secret, 'email-otp', otp),
        },
        async sendVerificationOTP({ email, otp, type }) {
          if (isIdentityEmail(email)) throw new Error('Not a delivery address');
          if (type !== 'sign-in')
            throw new Error('This example only supports sign-in email');
          try {
            await options.email.send({
              from: 'signin@example.test',
              to: [email],
              subject: options.appName
                ? `Your ${options.appName} sign-in code`
                : 'Your sign-in code',
              text: `Your sign-in code is ${otp}. It expires in 10 minutes.`,
              html: `<p>Your sign-in code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
            });
            diagnostic('email.delivery.succeeded');
          } catch (error) {
            diagnostic('email.delivery.failed', {
              stage: 'transport',
              reason: 'upstream_failure',
              ...diagnosticError(error),
            });
            throw error;
          }
        },
      }),
    ],
  };
}

export function createAuthApp(options: AuthAppOptions) {
  const db = connectDatabase(options.databaseUrl);
  const auth = betterAuth(authOptions({ ...options, database: db }));
  const app = new Hono();
  if (options.diagnostics)
    app.use('*', async (c, next) => {
      c.res = await observeRequest(
        c.req.raw,
        options.diagnostics!,
        async () => {
          await next();
          return c.res;
        },
      );
    });
  app.use('*', async (c, next) => {
    await next();
    const operation = requestOperation(c.req.raw);
    if (c.res.status >= 400)
      diagnostic('auth.rejected', {
        operation,
        status: c.res.status,
        reason: c.res.status === 429 ? 'rate_limited' : 'request_rejected',
      });
    else if (operation === 'auth.logout') diagnostic('auth.logout');
    else if (
      (operation === 'auth.email.verify' ||
        operation === 'auth.oauth.callback') &&
      c.res.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.includes('.session_token=') && !cookie.includes('Max-Age=0'),
        )
    )
      diagnostic('auth.login.succeeded', {
        operation,
        provider:
          operation === 'auth.oauth.callback'
            ? (new URL(c.req.url).pathname.split('/').at(-1) as Provider)
            : undefined,
      });
  });
  protectAuth(app, { ...options, database: db });
  app.on(['POST', 'GET'], '/api/auth/*', async (c) =>
    publicAuthResponse(
      await oauthRequest(c.req.raw, auth, { ...options, database: db }),
    ),
  );
  app.get('/api/providers', (c) => c.json(Object.keys(options.oauth ?? {})));
  app.onError((error, c) => {
    diagnostic('request.failed', {
      operation: requestOperation(c.req.raw),
      reason: 'unexpected_error',
      ...diagnosticError(error),
    });
    return c.json({ message: 'Authentication failed; please try again' }, 500);
  });
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

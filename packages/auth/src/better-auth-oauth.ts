import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { verifyProviderIdToken } from 'better-auth/oauth2';
import type { GithubProfile } from 'better-auth/social-providers';
import { makeSignature } from 'better-auth/crypto';
import { sql } from 'kysely';
import { equal, keyed } from './better-auth-security.ts';
import type { connectDatabase } from 'pgstencil/postgres';

export const providers = ['google', 'apple', 'facebook', 'github'] as const;
export type Provider = (typeof providers)[number];
export type OAuthSettings = Partial<
  Record<Provider, { clientId: string; clientSecret: string }>
>;

/** Pin the redirect flow's OIDC checks explicitly on Better Auth 1.7.3.
 * Its Google/Apple provider metadata supports verification, but their default
 * redirect getUserInfo only decodes claims. Use the library's actual verifier.
 */
export const verifiedOidc: BetterAuthPlugin = {
  id: 'pgstencil-verified-oidc',
  init(context) {
    for (const provider of context.socialProviders) {
      if (provider.id !== 'google' && provider.id !== 'apple') continue;
      provider.requiresIdTokenNonce = true;
      provider.issuer =
        provider.id === 'google'
          ? 'https://accounts.google.com'
          : 'https://appleid.apple.com';
      if (provider.idToken && 'jwks' in provider.idToken)
        provider.idToken.algorithms = ['RS256'];
      const authorization = provider.createAuthorizationURL.bind(provider);
      provider.createAuthorizationURL = async (data) => {
        if (!data.idTokenNonce) throw new Error('Missing OIDC nonce');
        const url = await authorization(data);
        url.searchParams.set('nonce', data.idTokenNonce);
        return url;
      };
      const info = provider.getUserInfo.bind(provider);
      provider.getUserInfo = async (tokens) => {
        if (
          !tokens.idToken ||
          !tokens.expectedIdTokenNonce ||
          !(await verifyProviderIdToken(
            provider,
            tokens.idToken,
            tokens.expectedIdTokenNonce,
          ))
        )
          return null;
        return info(tokens);
      };
    }
  },
};
export function oauthFromEnvironment(
  env: Record<string, string | undefined>,
): OAuthSettings {
  const result: OAuthSettings = {};
  for (const provider of providers) {
    const clientId = env[`${provider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = env[`${provider.toUpperCase()}_CLIENT_SECRET`];
    if (!clientId && !clientSecret) continue;
    if (!clientId?.trim() || !clientSecret?.trim())
      throw new Error(
        `Set both ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET`,
      );
    result[provider] = { clientId, clientSecret };
  }
  return result;
}

export function socialProviders(
  settings: OAuthSettings = {},
): BetterAuthOptions['socialProviders'] {
  return {
    ...settings,
    ...(settings.facebook
      ? {
          facebook: {
            ...settings.facebook,
            // Better Auth validates the Graph token's app and user before reading /me.
            // Facebook's authenticated primary email is our proof, as in the old adapter.
            mapProfileToUser: async (profile) => ({
              emailVerified: !!profile.email,
            }),
          },
        }
      : {}),
    ...(settings.github
      ? {
          github: {
            ...settings.github,
            // Public profile email can be stale. Require the verified PRIMARY address.
            getUserInfo: async (tokens) => {
              const get = async (url: string) => {
                const response = await fetch(url, {
                  headers: {
                    authorization: `Bearer ${tokens.accessToken}`,
                    'user-agent': 'pgstencil',
                    accept: 'application/vnd.github+json',
                  },
                });
                if (!response.ok)
                  throw new Error('GitHub identity request failed');
                return response.json();
              };
              const profile = (await get(
                'https://api.github.com/user',
              )) as GithubProfile;
              if (
                !/^[0-9]+$/.test(String(profile.id)) ||
                Number(profile.id) <= 0
              )
                return null;
              for (let page = 1; page <= 10; page++) {
                const emails = (await get(
                  `https://api.github.com/user/emails?per_page=100&page=${page}`,
                )) as { email: string; primary: boolean; verified: boolean }[];
                if (!Array.isArray(emails)) return null;
                const primary = emails.find(
                  (email) => email.primary === true && email.verified === true,
                );
                if (primary)
                  return {
                    user: {
                      name: profile.name ?? profile.login ?? '',
                      email: primary.email,
                      emailVerified: true,
                    },
                    data: profile,
                  };
                if (emails.length < 100) break;
              }
              return null;
            },
          },
        }
      : {}),
  };
}

type AuthHandle = {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(options: { headers: Headers }): Promise<{
      session: { id: string; createdAt: Date };
      user: { id: string };
    } | null>;
  };
};
/** Restrict redirect inputs and bind explicit linking to the initiating live session. */
export async function oauthRequest(
  request: Request,
  auth: AuthHandle,
  options: {
    database: ReturnType<typeof connectDatabase>;
    origin: string;
    secret: string;
    oauth?: OAuthSettings;
    successPath?: string;
    errorPath?: string;
  },
): Promise<Response> {
  const path = new URL(request.url).pathname.slice('/api/auth'.length);
  const fail = () => {
    const url = new URL(options.errorPath ?? '/', options.origin);
    url.searchParams.set('error', 'oauth_failed');
    return Response.redirect(url.href, 303);
  };
  if (path === '/sign-in/social' || path === '/link-social') {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      !providers.includes(body.provider as Provider) ||
      !options.oauth?.[body.provider as Provider]
    )
      return Response.json(
        { message: 'Provider unavailable' },
        { status: 404 },
      );
    const session =
      path === '/link-social'
        ? await auth.api.getSession({ headers: request.headers })
        : null;
    if (
      path === '/link-social' &&
      (!session || Date.now() - session.session.createdAt.getTime() >= 600_000)
    )
      return Response.json(
        { message: 'Sign in again before connecting an account' },
        { status: 401 },
      );
    // No caller-controlled redirects, scopes, token shortcuts or OAuth metadata.
    const clean = {
      provider: body.provider,
      disableRedirect: true,
      callbackURL: options.origin + (options.successPath ?? '/'),
      errorCallbackURL: options.origin + (options.errorPath ?? '/'),
      additionalData: {
        pgstencilProvider: body.provider,
        ...(session ? { pgstencilSession: session.session.id } : {}),
      },
    };
    return auth.handler(new Request(request, { body: JSON.stringify(clean) }));
  }
  if (path.startsWith('/callback/') && request.method === 'GET') {
    const state = new URL(request.url).searchParams.get('state');
    const provider = path.slice('/callback/'.length) as Provider;
    if (!state || !providers.includes(provider) || !options.oauth?.[provider])
      return fail();
    const prefix = options.origin.startsWith('https:')
      ? '__Host-pgstencil'
      : 'pgstencil';
    const raw = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix + '.state='))
      ?.slice(prefix.length + '.state='.length);
    try {
      if (
        !raw ||
        !equal(
          decodeURIComponent(raw),
          `${state}.${await makeSignature(state, options.secret)}`,
        )
      )
        return fail();
    } catch {
      return fail();
    }
    const result = await sql<{
      value: string;
      expiresAt: Date;
    }>`SELECT value, "expiresAt" FROM verification WHERE identifier = ${state} ORDER BY "createdAt" DESC LIMIT 1`.execute(
      options.database,
    );
    const row = result.rows[0];
    if (!row || row.expiresAt.getTime() <= Date.now()) return fail();
    let data: {
      pgstencilProvider?: string;
      pgstencilSession?: string;
      link?: { userId: string };
    };
    try {
      data = JSON.parse(row.value) as typeof data;
    } catch {
      return fail();
    }
    if (data.pgstencilProvider !== provider) return fail();
    if (data.link) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (
        !session ||
        session.session.id !== data.pgstencilSession ||
        session.user.id !== data.link.userId
      )
        return fail();
    }
    // Upstream checks state but uses separate read/delete calls. Claim it once
    // in Postgres before exchanging the code, including across Worker isolates.
    await sql`DELETE FROM pgstencil_oauth_claims WHERE expires_at <= ${new Date()}`.execute(
      options.database,
    );
    const claim =
      await sql`INSERT INTO pgstencil_oauth_claims (key, expires_at) VALUES (${keyed(options.secret, 'oauth-state', state)}, ${row.expiresAt}) ON CONFLICT DO NOTHING RETURNING key`.execute(
        options.database,
      );
    if (claim.rows.length !== 1) return fail();
  }
  const response = await auth.handler(request);
  // Do not forward provider error descriptions or codes into URLs, logs or pages.
  const location = response.headers.get('location');
  if (path.startsWith('/callback/') && location) {
    const redirect = new URL(location, options.origin);
    if (redirect.searchParams.has('error')) return fail();
  }
  return response;
}

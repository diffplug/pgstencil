import * as client from 'openid-client';
import { normalizeEmail } from './security.ts';

export const PROVIDERS = ['google', 'github'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<Provider, string> = {
  google: 'Google',
  github: 'GitHub',
};
export const PROVIDER_ORIGINS: Record<Provider, string> = {
  google: 'https://accounts.google.com',
  github: 'https://github.com',
};
export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}
export type OAuthSettings = Partial<Record<Provider, OAuthCredentials>>;
export type OAuthFetch = client.CustomFetch;
export interface OAuthProof {
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
}
export interface ProviderIdentity {
  subject: string;
  email: string;
}
export class IdentityError extends Error {}
const GITHUB_HEADERS = new Headers({
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2026-03-10',
  'user-agent': 'pgstencil',
});
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IdentityError('Invalid provider response');
  return value as Record<string, unknown>;
}
function verifiedEmail(value: unknown): string {
  const email = typeof value === 'string' ? normalizeEmail(value) : undefined;
  if (!email) throw new IdentityError('A verified email address is required.');
  return email;
}

/** The OAuth/OIDC protocol belongs to openid-client; provider-specific identity policy lives here. */
export class OAuthProviders {
  readonly enabled: Provider[];
  private configurations = new Map<Provider, Promise<client.Configuration>>();
  constructor(
    private readonly settings: OAuthSettings,
    private readonly transport?: OAuthFetch,
  ) {
    this.enabled = PROVIDERS.filter(
      (provider) => settings[provider] !== undefined,
    );
    for (const provider of this.enabled) {
      const credentials = settings[provider]!;
      if (!credentials.clientId.trim() || !credentials.clientSecret.trim())
        throw new Error(
          `${PROVIDER_LABELS[provider]} requires a client ID and client secret`,
        );
    }
  }
  private configuration(provider: Provider): Promise<client.Configuration> {
    if (!this.enabled.includes(provider))
      throw new Error('OAuth provider is not configured');
    let configuration = this.configurations.get(provider);
    if (!configuration) {
      configuration = this.configure(provider).catch((error) => {
        this.configurations.delete(provider); // Discovery failures must be retryable.
        throw error;
      });
      this.configurations.set(provider, configuration);
    }
    return configuration;
  }
  private async configure(provider: Provider): Promise<client.Configuration> {
    const { clientId, clientSecret } = this.settings[provider]!;
    if (provider === 'google') {
      return client.discovery(
        new URL(PROVIDER_ORIGINS.google),
        clientId,
        { client_secret: clientSecret, id_token_signed_response_alg: 'RS256' },
        client.ClientSecretPost(clientSecret),
        {
          timeout: 10,
          execute: [client.enableNonRepudiationChecks],
          ...(this.transport ? { [client.customFetch]: this.transport } : {}),
        },
      );
    }
    // GitHub implements OAuth 2, but does not publish OIDC discovery metadata.
    const config = new client.Configuration(
      {
        issuer: 'https://github.com',
        authorization_endpoint: 'https://github.com/login/oauth/authorize',
        token_endpoint: 'https://github.com/login/oauth/access_token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
      clientId,
      clientSecret,
      client.ClientSecretPost(clientSecret),
    );
    config.timeout = 10;
    if (this.transport) config[client.customFetch] = this.transport;
    return config;
  }
  async authorizationUrl(
    provider: Provider,
    proof: OAuthProof,
    connecting: boolean,
  ): Promise<URL> {
    const config = await this.configuration(provider);
    const parameters: Record<string, string> = {
      redirect_uri: proof.redirectUri,
      scope: provider === 'google' ? 'openid email' : 'read:user user:email',
      state: proof.state,
      code_challenge: await client.calculatePKCECodeChallenge(proof.verifier),
      code_challenge_method: 'S256',
    };
    if (provider === 'google') parameters.nonce = proof.nonce;
    if (connecting) parameters.prompt = 'select_account';
    return client.buildAuthorizationUrl(config, parameters);
  }
  async identity(
    provider: Provider,
    callback: URL,
    proof: OAuthProof,
  ): Promise<ProviderIdentity> {
    const config = await this.configuration(provider);
    const tokens = await client.authorizationCodeGrant(config, callback, {
      expectedState: proof.state,
      pkceCodeVerifier: proof.verifier,
      ...(provider === 'google'
        ? { expectedNonce: proof.nonce, idTokenExpected: true }
        : {}),
    });
    // Tokens are used only during this call. Never persist or log them.
    if (provider === 'google') {
      const claims = tokens.claims();
      if (!claims || claims.email_verified !== true)
        throw new IdentityError(
          'Google must provide a verified email address.',
        );
      if (
        typeof claims.sub !== 'string' ||
        !/^[\x21-\x7e]{1,255}$/.test(claims.sub)
      )
        throw new IdentityError('Invalid Google identity');
      return { subject: claims.sub, email: verifiedEmail(claims.email) };
    }
    const resource = async (url: string) => {
      const response = await client.fetchProtectedResource(
        config,
        tokens.access_token,
        new URL(url),
        'GET',
        undefined,
        GITHUB_HEADERS,
      );
      if (!response.ok) throw new Error('GitHub identity request failed');
      return (await response.json()) as unknown;
    };
    const emailPage = (page: number) =>
      resource(`https://api.github.com/user/emails?per_page=100&page=${page}`);
    // The profile and the first page of addresses depend only on the access
    // token, so one round trip serves both.
    const [profileResponse, firstPage] = await Promise.all([
      resource('https://api.github.com/user'),
      emailPage(1),
    ]);
    const profile = object(profileResponse);
    if (
      typeof profile.id !== 'number' ||
      !Number.isSafeInteger(profile.id) ||
      profile.id <= 0
    )
      throw new IdentityError('Invalid GitHub identity');
    // /user.email may be null, public, or stale. The authenticated email list
    // explicitly identifies the verified primary address, including private ones.
    for (let page = 1; page <= 10; page++) {
      const addresses = page === 1 ? firstPage : await emailPage(page);
      if (!Array.isArray(addresses))
        throw new IdentityError('Invalid GitHub email response');
      for (const value of addresses) {
        const address = object(value);
        if (address.primary === true && address.verified === true)
          return {
            subject: String(profile.id),
            email: verifiedEmail(address.email),
          };
      }
      if (addresses.length < 100) break;
    }
    throw new IdentityError(
      'GitHub must provide a verified primary email address.',
    );
  }
}

export function oauthFromEnvironment(env: NodeJS.ProcessEnv): OAuthSettings {
  const settings: OAuthSettings = {};
  for (const provider of PROVIDERS) {
    const prefix = provider.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (!clientId && !clientSecret) continue;
    if (!clientId?.trim() || !clientSecret?.trim())
      throw new Error(
        `Set both ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET`,
      );
    settings[provider] = { clientId, clientSecret };
  }
  return settings;
}

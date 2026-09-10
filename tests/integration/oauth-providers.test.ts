import { test, expect } from 'vitest';
import {
  OAuthProviders,
  type OAuthProof,
} from '../../examples/login/src/oauth-providers.ts';
import {
  mockOAuthServer,
  allOAuthCredentials,
} from '../support/oauth-server.ts';

const proof: OAuthProof = {
  state: 'state-from-browser',
  verifier: 'a'.repeat(64),
  nonce: 'nonce-from-browser',
  redirectUri: 'http://127.0.0.1:9876/oauth/callback',
};
type Mock = Awaited<ReturnType<typeof mockOAuthServer>>;
/** Every test here drives real clients against a local provider server. */
const providerTest = test.extend<{ server: Mock; clients: OAuthProviders }>({
  server: async ({}, use) => {
    const server = await mockOAuthServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },
  clients: async ({ server }, use) =>
    use(new OAuthProviders(allOAuthCredentials, server.transport)),
});
providerTest.for(['google', 'github'] as const)(
  '%s exchanges a code using PKCE and returns a verified stable identity',
  async (provider, { server, clients }) => {
    const url = await clients.authorizationUrl(provider, proof, false);
    expect(url.searchParams.get('state')).toBe(proof.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const identity = await clients.identity(
      provider,
      server.authorize(provider, url),
      proof,
    );
    expect(identity).toEqual({
      subject: provider === 'google' ? 'google-person-1' : '12345',
      email: 'oauth@example.test',
    });
    expect(
      server.requests.some(
        (r) => r.url.endsWith('/token') || r.url.endsWith('/access_token'),
      ),
    ).toBe(true);
    if (provider === 'google')
      expect(server.requests.some((r) => r.url.endsWith('/certs'))).toBe(true);
  },
);

providerTest.for([
  { badSignature: true },
  { claims: { iss: 'https://attacker.example' } },
  { claims: { aud: 'other-client' } },
  { claims: { nonce: 'other-nonce' } },
  { claims: { exp: 0 } },
  { missingIdToken: true },
  { verified: false },
])(
  'Google rejects invalid identity proof: %j',
  async (options, { server, clients }) => {
    const url = await clients.authorizationUrl('google', proof, false);
    await expect(
      clients.identity(
        'google',
        server.authorize('google', url, options),
        proof,
      ),
    ).rejects.toThrow();
  },
);

providerTest(
  'GitHub selects a verified private primary address across pages',
  async ({ server, clients }) => {
    const url = await clients.authorizationUrl('github', proof, false);
    const addresses = Array.from({ length: 100 }, () => ({
      email: 'secondary@example.test',
      primary: false,
      verified: true,
    }));
    addresses.push({
      email: 'primary@example.test',
      primary: true,
      verified: true,
    });
    expect(
      await clients.identity(
        'github',
        server.authorize('github', url, { githubEmails: addresses }),
        proof,
      ),
    ).toEqual({ subject: '12345', email: 'primary@example.test' });
  },
);

providerTest.for(['google', 'github'] as const)(
  '%s rejects a mismatched PKCE verifier',
  async (provider, { server, clients }) => {
    const url = await clients.authorizationUrl(provider, proof, false);
    await expect(
      clients.identity(provider, server.authorize(provider, url), {
        ...proof,
        verifier: 'b'.repeat(64),
      }),
    ).rejects.toThrow();
  },
);

providerTest('a discovery outage is retryable', async ({ server, clients }) => {
  server.failDiscovery(true);
  await expect(
    clients.authorizationUrl('google', proof, false),
  ).rejects.toThrow();
  server.failDiscovery(false);
  expect(
    (await clients.authorizationUrl('google', proof, false)).hostname,
  ).toBe('accounts.google.com');
});

providerTest.for(['apple', 'facebook'] as const)(
  '%s exchanges a browser-bound code without claiming unsupported PKCE',
  async (provider, { server, clients }) => {
    const url = await clients.authorizationUrl(provider, proof, false);
    expect(url.searchParams.get('state')).toBe(proof.state);
    expect(url.searchParams.has('code_challenge')).toBe(false);
    if (provider === 'apple') {
      expect(url.searchParams.get('nonce')).toBe(proof.nonce);
      expect(url.searchParams.get('response_mode')).toBe('form_post');
    }
    expect(
      await clients.identity(provider, server.authorize(provider, url), proof),
    ).toEqual({
      subject: provider === 'apple' ? 'apple-person-1' : '12345',
      email: 'oauth@example.test',
    });
  },
);
providerTest.for([
  { badSignature: true },
  { claims: { iss: 'https://attacker.example' } },
  { claims: { aud: 'other-client' } },
  { claims: { nonce: 'other-nonce' } },
  { claims: { exp: 0 } },
  { missingIdToken: true },
  { verified: false },
  { claims: { email_verified: 'false' } },
])(
  'Apple rejects invalid identity proof: %j',
  async (options, { server, clients }) => {
    const url = await clients.authorizationUrl('apple', proof, false);
    await expect(
      clients.identity('apple', server.authorize('apple', url, options), proof),
    ).rejects.toThrow();
  },
);
providerTest(
  'Apple accepts a verified private relay email with a string verification claim',
  async ({ server, clients }) => {
    const url = await clients.authorizationUrl('apple', proof, false);
    expect(
      await clients.identity(
        'apple',
        server.authorize('apple', url, {
          email: 'private@privaterelay.appleid.com',
          claims: { email_verified: 'true' },
        }),
        proof,
      ),
    ).toEqual({
      subject: 'apple-person-1',
      email: 'private@privaterelay.appleid.com',
    });
  },
);
providerTest.for([
  { email: '' },
  { subject: 'invalid' },
  { profileFailure: true },
  { tokenFailure: true },
])(
  'Facebook fails closed on missing identity or upstream failure: %j',
  async (options, { server, clients }) => {
    const url = await clients.authorizationUrl('facebook', proof, false);
    await expect(
      clients.identity(
        'facebook',
        server.authorize('facebook', url, options),
        proof,
      ),
    ).rejects.toThrow();
  },
);

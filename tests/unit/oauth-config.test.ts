import { expect, test } from 'vitest';
import {
  oauthFromEnvironment,
  OAuthProviders,
} from '../../examples/login/src/oauth-providers.ts';

test('OAuth configuration is optional and requires complete credentials for each enabled provider', () => {
  expect(oauthFromEnvironment({})).toEqual({});
  expect(
    oauthFromEnvironment({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
  ).toEqual({});
  expect(
    oauthFromEnvironment({
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
    }),
  ).toEqual({ google: { clientId: 'client', clientSecret: 'secret' } });
  expect(() => oauthFromEnvironment({ GITHUB_CLIENT_ID: 'client' })).toThrow(
    'Set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET',
  );
  expect(() =>
    oauthFromEnvironment({ GOOGLE_CLIENT_SECRET: 'secret' }),
  ).toThrow('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  expect(() =>
    oauthFromEnvironment({
      GOOGLE_CLIENT_ID: ' ',
      GOOGLE_CLIENT_SECRET: 'secret',
    }),
  ).toThrow();
  expect(
    () =>
      new OAuthProviders({ github: { clientId: 'client', clientSecret: '' } }),
  ).toThrow('GitHub requires');
});

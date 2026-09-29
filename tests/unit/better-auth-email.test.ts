import { test, expect } from 'vitest';
import {
  identityEmail,
  isIdentityEmail,
} from '../../packages/auth/src/better-auth-email.ts';

test('reserved identity emails include subdomains and DNS root dots', () => {
  for (const email of [
    'plain@identity.pgstencil.invalid',
    'PLAIN@IDENTITY.PGSTENCIL.INVALID',
    'sub@a.identity.pgstencil.invalid',
    'SUB@A.B.IDENTITY.PGSTENCIL.INVALID',
    'dotted@identity.pgstencil.invalid.',
    'dotted@a.identity.pgstencil.invalid.',
  ])
    expect(isIdentityEmail(email), email).toBe(true);
});

test('reserved identity email matching respects domain boundaries', () => {
  for (const email of [
    'user@example.test',
    'user@notidentity.pgstencil.invalid',
    'user@identity.pgstencil.invalid.example.test',
    'identity.pgstencil.invalid@example.test',
    'identity.pgstencil.invalid',
  ])
    expect(isIdentityEmail(email), email).toBe(false);
});

test('generated identity addresses retain their exact reserved domain', () => {
  const email = identityEmail('google', 'client-id', 'subject');
  expect(email).toMatch(/^[0-9a-f]{64}@identity\.pgstencil\.invalid$/);
  expect(isIdentityEmail(email)).toBe(true);
});

import { test, expect } from 'vitest';
import { createBetterAuthWorker } from '../../packages/auth/src/better-auth-workers.ts';
import type { DiagnosticRecord } from '../../packages/pgstencil/src/diagnostics.ts';

for (const diagnostics of [false, true])
  for (const failure of ['insecure origin', 'email factory'])
    test(`Workers auth errors keep security headers: ${failure}, diagnostics ${diagnostics}`, async () => {
      const records: DiagnosticRecord[] = [];
      const privateError = 'private-email@example.test secret-token';
      const app = createBetterAuthWorker({
        ...(diagnostics
          ? {
              diagnostics: {
                sink: (record: DiagnosticRecord) => records.push(record),
              },
            }
          : {}),
        email: () => {
          if (failure === 'email factory') throw new Error(privateError);
          return { send: async () => {} };
        },
      });
      const response = await app.fetch(
        new Request('https://auth.example.test/api/auth/get-session'),
        {
          APP_ORIGIN: `${failure === 'insecure origin' ? 'http' : 'https'}://auth.example.test`,
          AUTH_SECRET: 'worker-test-secret-at-least-32-characters',
          HYPERDRIVE: { connectionString: 'postgres://unused' },
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      expect(await response.json()).toEqual({
        message: diagnostics
          ? 'Temporarily unavailable. Please try again.'
          : 'Sign-in is temporarily unavailable. Please try again.',
      });
      if (diagnostics) {
        expect(response.headers.get('x-request-id')).toBeTruthy();
        expect(
          records.some((record) => record.event === 'request.failed'),
        ).toBe(true);
        expect(JSON.stringify(records)).not.toContain(privateError);
      }
    });

test('a Workers hook factory that throws leaves auth requests working', async () => {
  const records: DiagnosticRecord[] = [];
  const app = createBetterAuthWorker({
    diagnostics: { sink: (record: DiagnosticRecord) => records.push(record) },
    email: () => ({ send: async () => {} }),
    hooks: () => {
      throw new Error('private-hook@example.test');
    },
  });
  // A route the inner app answers without the (unreachable) database.
  const response = await app.fetch(
    new Request('https://auth.example.test/api/providers'),
    {
      APP_ORIGIN: 'https://auth.example.test',
      AUTH_SECRET: 'worker-test-secret-at-least-32-characters',
      HYPERDRIVE: { connectionString: 'postgres://unused' },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
  expect(records.map((record) => record.event)).toContain('auth.hook.failed');
  expect(JSON.stringify(records)).not.toContain('private-hook@example.test');
});

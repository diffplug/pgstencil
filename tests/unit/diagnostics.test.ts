import { test, expect } from 'vitest';
import {
  diagnostic,
  diagnosticError,
  observeRequest,
  withDiagnostics,
  type DiagnosticFields,
  type DiagnosticRecord,
} from '../../packages/pgstencil/src/diagnostics.ts';
import { DevTime } from '../../packages/pgstencil/src/time.ts';

const id = '11111111-1111-4111-8111-111111111111';
test('diagnostics allowlist drops secrets even in unexpected fields and malformed values', async () => {
  const records: DiagnosticRecord[] = [];
  const time = new DevTime();
  const secret = 'private-email@example.test secret-token';
  const result = await observeRequest(
    new Request(
      `https://example.test/api/auth/callback/microsoft?code=${encodeURIComponent(secret)}`,
      {
        headers: {
          cookie: secret,
          authorization: secret,
          'x-request-id': secret,
        },
      },
    ),
    {
      sink: (record) => records.push(record),
      time,
      requestId: () => id,
      revision: 'a'.repeat(40),
    },
    async () => {
      diagnostic('auth.oauth.failed', {
        provider: 'microsoft',
        stage: 'id_token',
        reason: 'id_token_rejected',
        nonceMatches: false,
        email: secret,
        token: secret,
        error: new Error(secret),
        requestId: secret,
        message: secret,
        httpStatus: secret,
      } as unknown as DiagnosticFields);
      diagnostic('auth.oauth.failed', {
        provider: secret,
        stage: secret,
        errorCode: secret,
      } as unknown as DiagnosticFields);
      time.advanceMilliseconds(25);
      return new Response('ok');
    },
  );
  expect(result.headers.get('x-request-id')).toBe(id);
  expect(records[0]).toEqual({
    source: 'pgstencil',
    version: 1,
    event: 'auth.oauth.failed',
    level: 'error',
    timestamp: '2020-01-01T00:00:00.000Z',
    requestId: id,
    revision: 'a'.repeat(40),
    provider: 'microsoft',
    stage: 'id_token',
    reason: 'id_token_rejected',
    nonceMatches: false,
  });
  expect(records.at(-1)).toMatchObject({
    event: 'request.completed',
    operation: 'auth.oauth.callback',
    durationMs: 25,
    status: 200,
  });
  expect(JSON.stringify(records)).not.toContain(secret);
  expect(records[1]).not.toHaveProperty('provider');
  expect(
    diagnosticError(
      Object.assign(new Error(secret), {
        code: 'ECONNRESET',
        cause: secret,
        body: secret,
      }),
    ),
  ).toEqual({ errorType: 'Error', errorCode: 'ECONNRESET' });
});

test('concurrent request logs preserve their own context and do not log arbitrary routes', async () => {
  const records: DiagnosticRecord[] = [];
  await Promise.all(
    [1, 2].map(async (n) =>
      observeRequest(
        new Request('https://example.test/private-email@example.test'),
        {
          sink: (record) => records.push(record),
          requestId: () => id.slice(0, -1) + n,
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, n));
          diagnostic('auth.oauth.stage', {
            provider: n === 1 ? 'google' : 'microsoft',
            stage: 'profile',
          });
          return new Response('ok');
        },
      ),
    ),
  );
  expect(
    records.map(({ provider, requestId }) => ({ provider, requestId })),
  ).toEqual([
    { provider: 'google', requestId: id.slice(0, -1) + '1' },
    { provider: 'microsoft', requestId: id.slice(0, -1) + '2' },
  ]);
  expect(JSON.stringify(records)).not.toContain('private-email');
  const before = records.length;
  diagnostic('email.delivery.succeeded');
  expect(records).toHaveLength(before);
});

test('a broken sink never changes successful responses or reveals thrown exception text', async () => {
  const result = await observeRequest(
    new Request('https://example.test/api/health'),
    {
      sink: () => {
        throw new Error('sink failed');
      },
    },
    async () => new Response('healthy'),
  );
  expect(await result.text()).toBe('healthy');
  const records: DiagnosticRecord[] = [];
  const failure = await observeRequest(
    new Request('https://example.test/api/secret'),
    { sink: (r) => records.push(r) },
    async () => {
      throw new Error('password=private');
    },
  );
  expect(failure.status).toBe(503);
  expect(JSON.stringify(records)).not.toContain('password');
  expect(await failure.text()).not.toContain('password');
  withDiagnostics({ sink: (r) => records.push(r) }, () =>
    diagnostic('auth.oauth.failed', { reason: 'provider_cancelled' }),
  );
  expect(records.at(-1)?.level).toBe('info');
});

test('provider error extraction keeps numeric codes and tolerates hostile getters', () => {
  expect(
    diagnosticError({
      error: 'invalid_client',
      error_codes: [7000215],
      error_description: 'secret',
    }),
  ).toEqual({ errorCode: 'invalid_client', providerCode: 7000215 });
  expect(
    diagnosticError({
      error: 'invalid_grant',
      error_codes: [50173],
      error_description: 'secret',
    }),
  ).toEqual({ errorCode: 'invalid_grant', providerCode: 50173 });
  expect(
    diagnosticError({
      get name() {
        throw new Error('private');
      },
    }),
  ).toEqual({});
});

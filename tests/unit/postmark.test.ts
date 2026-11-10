import { test, expect, vi, afterEach } from 'vitest';
import { postmarkEmail } from '../../packages/auth/src/postmark.ts';
import { diagnosticError } from '../../packages/pgstencil/src/diagnostics.ts';

afterEach(() => vi.unstubAllGlobals());

const message = {
  from: 'Someone Else <signin@other.example.test>',
  to: ['alice@example.test'],
  subject: 'Your sign-in code',
  text: 'Your sign-in code is 12345678.',
  html: '<p>12345678</p>',
};

function stub(status: number, body: string) {
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push(new Request(url, init));
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return requests;
}

async function failure(status: number, body: string) {
  stub(status, body);
  const error = await postmarkEmail('token', 'App <signin@app.example.test>')
    .send(message)
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(error).toBeInstanceOf(Error);
  return error as Error & { httpStatus: number; providerCode?: number };
}

test("postmark sends from the adapter's own sender, overriding message.from", async () => {
  const requests = stub(200, JSON.stringify({ ErrorCode: 0, Message: 'OK' }));
  await postmarkEmail('token', 'App <signin@app.example.test>').send(message);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get('x-postmark-server-token')).toBe('token');
  expect(await requests[0]!.json()).toMatchObject({
    From: 'App <signin@app.example.test>',
    To: 'alice@example.test',
  });
});

test('postmark failures carry the numeric ErrorCode as providerCode, never the message text', async () => {
  const error = await failure(
    422,
    JSON.stringify({
      ErrorCode: 406,
      Message: 'You tried to send to recipient alice@example.test (inactive)',
    }),
  );
  expect(error.message).toBe('Email delivery failed');
  expect(error.httpStatus).toBe(422);
  expect(error.providerCode).toBe(406);
  expect(JSON.stringify(error)).not.toContain('alice@example.test');
  expect(diagnosticError(error)).toMatchObject({
    httpStatus: 422,
    providerCode: 406,
  });
});

test('postmark failures omit providerCode when the body has no numeric ErrorCode', async () => {
  for (const body of [
    'upstream unavailable',
    JSON.stringify({ ErrorCode: '406' }),
    JSON.stringify({ Message: 'no code' }),
    'null',
  ]) {
    const error = await failure(503, body);
    expect(error.httpStatus, body).toBe(503);
    expect(error.providerCode, body).toBeUndefined();
  }
});

test('postmark treats a 2xx with a nonzero or missing ErrorCode as a failure', async () => {
  expect(
    (await failure(200, JSON.stringify({ ErrorCode: 300 }))).providerCode,
  ).toBe(300);
  expect((await failure(200, '{}')).providerCode).toBeUndefined();
});

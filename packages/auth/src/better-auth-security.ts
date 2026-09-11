import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { connectDatabase } from 'pgstencil/postgres';

export function keyed(secret: string, purpose: string, value: string) {
  return createHmac('sha256', secret)
    .update(purpose)
    .update('\0')
    .update(value)
    .digest('hex');
}
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookies(request: Request) {
  return new Map(
    (request.headers.get('cookie') ?? '').split(';').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1)];
    }),
  );
}

/** Shared, atomic limits: changing client IP cannot reset an email's budget. */
async function consume(
  db: ReturnType<typeof connectDatabase>,
  key: string,
  max: number,
  windowMs: number,
) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);
  const result = await sql<{ count: number }>`
    INSERT INTO pgstencil_auth_limits (key, count, started_at)
    VALUES (${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN pgstencil_auth_limits.started_at <= ${cutoff} THEN 1 ELSE pgstencil_auth_limits.count + 1 END,
      started_at = CASE WHEN pgstencil_auth_limits.started_at <= ${cutoff} THEN ${now} ELSE pgstencil_auth_limits.started_at END
    WHERE pgstencil_auth_limits.started_at <= ${cutoff} OR pgstencil_auth_limits.count < ${max}
    RETURNING count
  `.execute(db);
  return result.rows.length === 1;
}

export function protectAuth(
  app: Hono,
  options: {
    origin: string;
    secret: string;
    database: ReturnType<typeof connectDatabase>;
    ipAddressHeaders?: string[];
  },
) {
  const secure = options.origin.startsWith('https:');
  const cookieName = secure ? '__Host-pgstencil.csrf' : 'pgstencil.csrf';
  const verify = (value: string | undefined) => {
    if (!value || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) return false;
    const [token, signature] = value.split('.') as [string, string];
    return equal(signature, keyed(options.secret, 'csrf', token));
  };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    await next();
  });
  app.use('/api/auth/*', bodyLimit({ maxSize: 16 * 1024 }));
  app.get('/api/auth/csrf', (c) => {
    let value = cookies(c.req.raw).get(cookieName);
    if (!verify(value)) {
      const token = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString('hex');
      value = `${token}.${keyed(options.secret, 'csrf', token)}`;
      c.header(
        'Set-Cookie',
        `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
      );
    }
    return c.json({ csrf: value!.split('.')[0] });
  });
  app.use('/api/auth/*', async (c, next) => {
    const path = c.req.path.slice('/api/auth'.length);
    const callback = /^\/callback\/(google|github|apple|facebook)$/.test(path);
    const reads = ['/get-session', '/list-accounts'];
    const writes = [
      '/email-otp/send-verification-otp',
      '/sign-in/email-otp',
      '/sign-in/social',
      '/link-social',
      '/sign-out',
    ];
    if (callback) {
      if (c.req.method === 'GET') return next();
      // Apple form_post carries no Lax cookies; Better Auth relays it to a GET
      // which checks the signed browser state AND atomically consumes DB state.
      if (
        path === '/callback/apple' &&
        c.req.method === 'POST' &&
        c.req.header('content-type')?.split(';')[0] ===
          'application/x-www-form-urlencoded'
      )
        return next();
      return c.json({ message: 'Method not allowed' }, 405);
    }
    if (c.req.method === 'GET' && reads.includes(path)) return next();
    if (c.req.method !== 'POST' || !writes.includes(path))
      return c.json({ message: 'Not found' }, 404);
    if (c.req.header('origin') !== options.origin)
      return c.json({ message: 'Invalid origin' }, 403);
    const cookie = cookies(c.req.raw).get(cookieName);
    if (
      !verify(cookie) ||
      !equal(c.req.header('x-csrf-token') ?? '', cookie!.split('.')[0]!)
    )
      return c.json({ message: 'Invalid CSRF token' }, 403);
    if (c.req.header('content-type')?.split(';')[0] !== 'application/json')
      return c.json({ message: 'Send JSON' }, 415);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.raw.clone().json()) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Error();
    } catch {
      return c.json({ message: 'Invalid JSON' }, 400);
    }
    if (
      path === '/email-otp/send-verification-otp' ||
      path === '/sign-in/email-otp'
    ) {
      const email =
        typeof body.email === 'string' ? body.email.toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
        return c.json({ message: 'Invalid email' }, 400);
      const send = path === '/email-otp/send-verification-otp';
      if (send && body.type !== 'sign-in')
        return c.json({ message: 'Unsupported email operation' }, 400);
      const ip =
        (options.ipAddressHeaders ?? ['x-pgstencil-client-ip'])
          .map((name) => c.req.header(name))
          .find(Boolean) ?? 'unknown';
      // Bound per-email counter creation even after upstream IP limits reject.
      if (
        !(await consume(
          options.database,
          `${send ? 'send' : 'verify'}:ip:${keyed(options.secret, 'ip-rate', ip)}`,
          send ? 30 : 100,
          15 * 60_000,
        ))
      )
        return c.json({ message: 'Please wait before trying again.' }, 429);
      await sql`DELETE FROM pgstencil_auth_limits WHERE started_at < ${new Date(Date.now() - 15 * 60_000)}`.execute(
        options.database,
      );
      const key = keyed(options.secret, 'email-rate', email);
      const allowed =
        (!send ||
          (await consume(options.database, `cooldown:${key}`, 1, 60_000))) &&
        (await consume(
          options.database,
          `${send ? 'send' : 'verify'}:${key}`,
          send ? 5 : 15,
          15 * 60_000,
        ));
      if (!allowed)
        return c.json({ message: 'Please wait before trying again.' }, 429);
    }
    if (
      (path === '/sign-in/social' || path === '/link-social') &&
      (body.idToken || body.accessToken)
    )
      return c.json({ message: 'Use the browser OAuth redirect flow' }, 400);
    await next();
  });
}

/** The browser only needs public session data, never upstream session tokens. */
export async function publicAuthResponse(response: Response) {
  if (
    (response.status >= 300 && response.status < 400) ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    return response;
  const body: unknown = await response.json();
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              'token',
              'accessToken',
              'refreshToken',
              'idToken',
              'singleSession',
            ].includes(key),
        )
        .map(([key, item]) => [key, scrub(item)]),
    );
  };
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(scrub(body)), {
    status: response.status,
    headers,
  });
}

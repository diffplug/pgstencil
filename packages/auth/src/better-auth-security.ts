import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import { isIdentityEmail } from './better-auth-email.ts';
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

/**
 * The one header Better Auth and the email budgets read a client IP from.
 * `protectAuth` always overwrites or deletes it before any handler runs.
 */
export const clientIpHeader = 'x-pgstencil-client-ip';

/**
 * Better Auth's per-IP limiter, keyed by an HMAC of its `<ip>|<path>` key so the
 * table never holds a raw address. One upsert decides and increments atomically,
 * across requests and Worker isolates, with Better Auth's rolling-window rule.
 */
export function rateLimitStorage(
  db: ReturnType<typeof connectDatabase>,
  secret: string,
) {
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const hashed = keyed(secret, 'rate-limit', key);
      const now = Date.now();
      const cutoff = now - rule.window * 1000;
      const result = await sql<{ count: number }>`
        INSERT INTO "rateLimit" (id, key, count, "lastRequest")
        VALUES (gen_random_uuid()::text, ${hashed}, 1, ${now})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN "rateLimit"."lastRequest" <= ${cutoff} THEN 1 ELSE "rateLimit".count + 1 END,
          "lastRequest" = ${now}
        WHERE "rateLimit"."lastRequest" <= ${cutoff} OR "rateLimit".count < ${rule.max}
        RETURNING count
      `.execute(db);
      if (result.rows.length === 1) {
        // Better Auth's windows are at most a minute; an hour-old row is dead.
        if (result.rows[0]!.count === 1)
          await sql`DELETE FROM "rateLimit" WHERE "lastRequest" < ${now - 3_600_000}`.execute(
            db,
          );
        return { allowed: true, retryAfter: null };
      }
      const last = await sql<{
        lastRequest: string;
      }>`SELECT "lastRequest" FROM "rateLimit" WHERE key = ${hashed}`.execute(
        db,
      );
      const since = Number(last.rows[0]?.lastRequest ?? now);
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((since + rule.window * 1000 - now) / 1000),
        ),
      };
    },
  };
}

/**
 * Better Auth's `normalizeIP(ip, { ipv6Subnet: 64 })`, which it does not
 * re-export: IPv6 collapses to its /64 and IPv4-mapped IPv6 to IPv4, so one
 * host cannot rotate addresses within its /64 for fresh budgets. A unit test
 * compares the two.
 */
export function ipBucket(ip: string) {
  if (!ip.includes(':')) return ip.toLowerCase();
  let host: string;
  try {
    host = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  } catch {
    return ip.toLowerCase();
  }
  const [left = '', right = ''] = host.split('::');
  const head = left ? left.split(':') : [];
  const tail = host.includes('::') && right ? right.split(':') : [];
  const groups = [
    ...head,
    ...Array<string>(8 - head.length - tail.length).fill('0'),
    ...tail,
  ].map((group) => group.padStart(4, '0'));
  if (groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff')
    return groups
      .slice(6)
      .flatMap((g) => [parseInt(g.slice(0, 2), 16), parseInt(g.slice(2), 16)])
      .join('.');
  return [...groups.slice(0, 4), '0000', '0000', '0000', '0000'].join(':');
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
    /** Trusted forwarded headers; without them only the Node socket counts. */
    ipAddressHeaders?: string[];
    accountLinking?: 'explicit' | 'same-email';
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
    // Never let a client name its own IP: derive it from the socket that
    // @hono/node-server passes as env.incoming, or from a header the
    // application explicitly trusts, then overwrite the internal header.
    const candidates = options.ipAddressHeaders
      ? options.ipAddressHeaders.map((name) => c.req.header(name))
      : [
          (
            c.env as
              { incoming?: { socket?: { remoteAddress?: string } } } | undefined
          )?.incoming?.socket?.remoteAddress,
        ];
    const ip = candidates
      .map((value) => value?.trim())
      .find((value) => !!value && /^[0-9A-Fa-f:.]{2,45}$/.test(value));
    const headers = new Headers(c.req.raw.headers);
    if (ip) headers.set(clientIpHeader, ip);
    else headers.delete(clientIpHeader);
    c.req.raw = new Request(c.req.raw, { headers });
    await next();
  });
  app.use('*', async (c, next) => {
    await next();
    // Apply to the final response, including upstream immutable redirects.
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
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
    if (path === '/link-social' && options.accountLinking === 'same-email')
      return c.json({ message: 'Not found' }, 404);
    const callback =
      /^\/callback\/(google|github|apple|facebook|microsoft)$/.test(path);
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
      if (
        isIdentityEmail(email) ||
        email.length > 254 ||
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
      )
        return c.json({ message: 'Invalid email' }, 400);
      const send = path === '/email-otp/send-verification-otp';
      if (send && body.type !== 'sign-in')
        return c.json({ message: 'Unsupported email operation' }, 400);
      const ip = ipBucket(c.req.header(clientIpHeader) ?? 'unknown');
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
              'emailAuthenticated',
            ].includes(key),
        )
        .map(([key, item]) => [
          key,
          key === 'email' && typeof item === 'string' && isIdentityEmail(item)
            ? null
            : scrub(item),
        ]),
    );
  };
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(scrub(body)), {
    status: response.status,
    headers,
  });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Auth, SESSION_MS } from './auth.ts';
import { OAuth } from './oauth.ts';
import { cookieValues, normalizeEmail, sessionCookie } from './security.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function readBody(
  req: IncomingMessage,
  limit = 8192,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new HttpError(415, 'Send JSON.');
  try {
    const value: unknown = JSON.parse((await readBody(req)).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON.');
  }
}
export function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res
    .writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    .end(JSON.stringify(value));
}
export interface SessionView {
  user: { id: string; email: string };
  createdAt: string;
  expiresAt: string;
}
export interface AuthState {
  session: SessionView | null;
  csrf: string;
  pendingEmail: string | null;
  providers: ('google' | 'github')[];
}

/** JSON adapter for SPA shells; cookies and all security decisions stay server-side. */
export function createAuthHttp(options: {
  auth: Auth;
  oauth: OAuth;
  secure: boolean;
  loginPath?: string;
  accountPath?: string;
  /** Only use a forwarded address after your trusted proxy overwrites that header. */
  clientAddress?: (req: IncomingMessage) => string;
}) {
  const { auth, oauth, secure } = options;
  const origin = auth.deps.origin;
  if (new URL(origin).origin !== origin)
    throw new Error('Auth requires an origin only');
  const loginPath = options.loginPath ?? '/login';
  const accountPath = options.accountPath ?? '/profile';
  for (const path of [loginPath, accountPath])
    if (!path.startsWith('/') || new URL(path, origin).origin !== origin)
      throw new Error('Auth redirects must be same-origin');
  const names = {
    session: secure ? '__Host-pgstencil' : 'pgstencil_dev',
    pending: secure ? '__Host-pgstencil-pending' : 'pgstencil_pending',
    oauth: secure ? '__Host-pgstencil-oauth' : 'pgstencil_oauth',
  };
  const source =
    options.clientAddress ??
    ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  const rawSession = (req: IncomingMessage) =>
    cookieValues(req.headers.cookie)[names.session];
  const session = (req: IncomingMessage) => auth.session(rawSession(req));
  const csrfHeader = (req: IncomingMessage) =>
    typeof req.headers['x-csrf-token'] === 'string'
      ? req.headers['x-csrf-token']
      : '';
  function setCookie(
    res: ServerResponse,
    name: string,
    value: string,
    seconds: number,
  ) {
    const existing =
      (res.getHeader('set-cookie') as string[] | undefined) ?? [];
    res.setHeader('set-cookie', [
      ...existing,
      sessionCookie(name, value, auth.deps.time.now(), seconds, secure),
    ]);
  }
  function redirect(res: ServerResponse, path: string) {
    res
      .writeHead(303, {
        location: path,
        'cache-control': 'no-store',
        'referrer-policy': 'strict-origin',
      })
      .end();
  }
  function checkOrigin(req: IncomingMessage) {
    if (req.headers.origin !== origin)
      throw new HttpError(403, 'Return to this site and try again.');
  }
  async function pending(req: IncomingMessage) {
    return auth.pending(cookieValues(req.headers.cookie)[names.pending]);
  }
  async function authorize(req: IncomingMessage, allowPending = false) {
    checkOrigin(req);
    const current = await session(req);
    if (current && auth.validSessionCsrf(current, csrfHeader(req)))
      return current;
    const flow = allowPending ? await pending(req) : undefined;
    if (flow && auth.validCsrf(flow, csrfHeader(req))) return undefined;
    throw new HttpError(
      current || allowPending ? 403 : 401,
      current || allowPending
        ? 'Refresh this page and try again.'
        : 'Sign in to continue.',
    );
  }
  function signedIn(res: ServerResponse, value: string) {
    setCookie(res, names.session, value, SESSION_MS / 1000);
    setCookie(res, names.pending, '', 0);
  }
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? '/', origin);
    const callback = /^\/oauth\/(google|github)\/callback$/.exec(url.pathname);
    if (
      !url.pathname.startsWith('/api/auth/') &&
      url.pathname !== '/login/link' &&
      !callback
    )
      return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'strict-origin');
    if (req.method === 'GET' && callback) {
      const provider = oauth.providers.enabled.find((id) => id === callback[1]);
      if (!provider) throw new HttpError(404, 'Sign-in method unavailable.');
      const result = await oauth.complete(
        provider,
        url,
        cookieValues(req.headers.cookie)[names.oauth],
        rawSession(req),
      );
      if (result.clearCookie) setCookie(res, names.oauth, '', 0);
      if (result.result.ok) {
        signedIn(res, result.result.session);
        redirect(res, accountPath);
      } else
        redirect(
          res,
          `${loginPath}?error=${encodeURIComponent(result.result.message)}`,
        );
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/login/link') {
      // A link preview never consumes a challenge. The SPA presents a confirm button.
      redirect(
        res,
        `${loginPath}#${new URLSearchParams({ id: url.searchParams.get('id') ?? '', token: url.searchParams.get('token') ?? '' })}`,
      );
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const current = await session(req);
      let flow = await pending(req);
      if (!current && !flow) {
        flow = await auth.newFlow();
        setCookie(res, names.pending, flow.cookie, 30 * 60);
      }
      sendJson(res, {
        session: current
          ? {
              user: { id: current.user_id, email: current.email },
              createdAt: current.created_at.toISOString(),
              expiresAt: current.expires_at.toISOString(),
            }
          : null,
        csrf: current ? auth.sessionCsrf(rawSession(req)!) : flow!.csrf,
        pendingEmail: flow?.flow.email ?? null,
        providers: [...oauth.providers.enabled],
      } satisfies AuthState);
      return true;
    }
    if (req.method !== 'POST') throw new HttpError(404, 'Route not found.');
    checkOrigin(req);
    const body = await readJson(req);
    const text = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string) : '';
    if (url.pathname === '/api/auth/logout') {
      await authorize(req);
      await auth.logout(rawSession(req)!);
      setCookie(res, names.session, '', 0);
      sendJson(res, { ok: true });
      return true;
    }
    const oauthRoute =
      /^\/api\/auth\/oauth\/(google|github)\/(start|connect)$/.exec(
        url.pathname,
      );
    if (oauthRoute?.[2] === 'connect') {
      const current = await authorize(req);
      const provider = oauth.providers.enabled.find(
        (id) => id === oauthRoute[1],
      );
      if (!provider) throw new HttpError(404, 'Sign-in method unavailable.');
      const result = await oauth.begin(provider, source(req), current);
      if (!result.ok) throw new HttpError(result.status, result.message);
      setCookie(res, names.oauth, result.cookie, result.seconds);
      sendJson(res, { url: result.url });
      return true;
    }
    const flow = await pending(req);
    if (!flow || !auth.validCsrf(flow, csrfHeader(req)))
      throw new HttpError(403, 'Start a new sign-in.');
    if (oauthRoute) {
      const provider = oauth.providers.enabled.find(
        (id) => id === oauthRoute[1],
      );
      if (!provider) throw new HttpError(404, 'Sign-in method unavailable.');
      const result = await oauth.begin(provider, source(req));
      if (!result.ok) throw new HttpError(result.status, result.message);
      setCookie(res, names.oauth, result.cookie, result.seconds);
      sendJson(res, { url: result.url });
      return true;
    }
    if (
      url.pathname === '/api/auth/email' ||
      url.pathname === '/api/auth/resend'
    ) {
      const email = normalizeEmail(
        url.pathname.endsWith('/resend')
          ? (flow.flow.email ?? '')
          : text('email'),
      );
      if (!email) throw new HttpError(400, 'Enter a valid email address.');
      const result = await auth.send(flow, email, source(req));
      if (!result.ok) throw new HttpError(result.status, result.message);
      sendJson(res, { ok: true });
      return true;
    }
    if (url.pathname === '/api/auth/verify') {
      const method = text('method');
      if (method !== 'code' && method !== 'link')
        throw new HttpError(400, 'Choose code or link verification.');
      const result = await auth.verify(
        flow,
        method,
        text('value'),
        text('id') || undefined,
        source(req),
        rawSession(req),
      );
      if (!result.ok) throw new HttpError(result.status, result.message);
      signedIn(res, result.session);
      sendJson(res, { ok: true });
      return true;
    }
    throw new HttpError(404, 'Route not found.');
  }
  return { handle, session, authorize, names, checkOrigin };
}

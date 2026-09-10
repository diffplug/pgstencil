import { Auth, SESSION_MS } from './auth.ts';
import { OAuth } from './oauth.ts';
import type { Provider } from './oauth-providers.ts';
import { cookieValues, normalizeEmail, sessionCookie } from './security.ts';
export { HttpError } from './http-error.ts';
import { HttpError } from './http-error.ts';

/** Read incrementally so a missing or forged Content-Length cannot bypass the limit. */
export async function readRequestBody(
  req: Request,
  limit = 8192,
): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0,
    body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request too large.');
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export async function readJsonRequest(
  req: Request,
): Promise<Record<string, unknown>> {
  if (
    req.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new HttpError(415, 'Send JSON.');
  try {
    const value: unknown = JSON.parse(await readRequestBody(req));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON.');
  }
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
  providers: Provider[];
}

/** JSON adapter for SPA shells; cookies and all security decisions stay server-side. */
export function createAuthFetch(options: {
  auth: Auth;
  oauth: OAuth;
  secure: boolean;
  loginPath?: string;
  accountPath?: string;
  /** Only use a forwarded address after your trusted proxy overwrites that header. */
  clientAddress?: (req: Request) => string;
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
  const source = options.clientAddress ?? (() => 'unknown');
  const rawSession = (req: Request) =>
    cookieValues(req.headers.get('cookie') ?? undefined)[names.session];
  const session = (req: Request) => auth.session(rawSession(req));
  const csrfHeader = (req: Request) => req.headers.get('x-csrf-token') ?? '';
  function setCookie(
    res: Headers,
    name: string,
    value: string,
    seconds: number,
  ) {
    res.append(
      'set-cookie',
      sessionCookie(name, value, auth.deps.time.now(), seconds, secure),
    );
  }
  function redirect(headers: Headers, path: string) {
    headers.set('location', path);
    return new Response(null, { status: 303, headers });
  }
  function json(headers: Headers, value: unknown) {
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(JSON.stringify(value), { headers });
  }
  function checkOrigin(req: Request) {
    if (req.headers.get('origin') !== origin)
      throw new HttpError(403, 'Return to this site and try again.');
  }
  async function pending(req: Request) {
    return auth.pending(
      cookieValues(req.headers.get('cookie') ?? undefined)[names.pending],
    );
  }
  async function authorize(req: Request, allowPending = false) {
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
  function signedIn(res: Headers, value: string) {
    setCookie(res, names.session, value, SESSION_MS / 1000);
    setCookie(res, names.pending, '', 0);
  }
  async function handle(req: Request): Promise<Response | undefined> {
    const incoming = new URL(req.url);
    const url = new URL(incoming.pathname + incoming.search, origin);
    const callback = /^\/oauth\/(google|github|apple|facebook)\/callback$/.exec(
      url.pathname,
    );
    if (
      !url.pathname.startsWith('/api/auth/') &&
      url.pathname !== '/login/link' &&
      !callback
    )
      return undefined;
    const res = new Headers({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    if (req.method === 'POST' && callback?.[1] === 'apple') {
      if (!oauth.providers.enabled.includes('apple'))
        throw new HttpError(404, 'Sign-in method unavailable.');
      if (
        req.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/x-www-form-urlencoded'
      )
        throw new HttpError(415, 'Send form data.');
      const form = new URLSearchParams(await readRequestBody(req));
      return redirect(res, appleCallbackLocation(form, url.pathname));
    }
    if (req.method === 'GET' && callback) {
      const provider = oauth.providers.enabled.find((id) => id === callback[1]);
      if (!provider) throw new HttpError(404, 'Sign-in method unavailable.');
      const result = await oauth.complete(
        provider,
        url,
        cookieValues(req.headers.get('cookie') ?? undefined)[names.oauth],
        rawSession(req),
      );
      if (result.clearCookie) setCookie(res, names.oauth, '', 0);
      if (result.result.ok) {
        signedIn(res, result.result.session);
        return redirect(res, accountPath);
      } else
        return redirect(
          res,
          `${loginPath}?error=${encodeURIComponent(result.result.message)}`,
        );
    }
    if (req.method === 'GET' && url.pathname === '/login/link') {
      // A link preview never consumes a challenge. The SPA presents a confirm button.
      return redirect(
        res,
        `${loginPath}#${new URLSearchParams({ id: url.searchParams.get('id') ?? '', token: url.searchParams.get('token') ?? '' })}`,
      );
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      const current = await session(req);
      let flow = await pending(req);
      if (!current && !flow) {
        flow = await auth.newFlow();
        setCookie(res, names.pending, flow.cookie, 30 * 60);
      }
      return json(res, {
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
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/providers') {
      const current = await session(req);
      if (!current) throw new HttpError(401, 'Sign in to continue.');
      const identities = await auth.deps.db
        .selectFrom('oauth_identities')
        .select('provider')
        .where('user_id', '=', current.user_id)
        .orderBy('provider')
        .execute();
      return json(
        res,
        identities.map((identity) => identity.provider),
      );
    }
    if (req.method !== 'POST') throw new HttpError(404, 'Route not found.');
    checkOrigin(req);
    const body = await readJsonRequest(req);
    const text = (key: string) =>
      typeof body[key] === 'string' ? (body[key] as string) : '';
    if (url.pathname === '/api/auth/logout') {
      await authorize(req);
      await auth.logout(rawSession(req)!);
      setCookie(res, names.session, '', 0);
      return json(res, { ok: true });
    }
    const oauthRoute =
      /^\/api\/auth\/oauth\/(google|github|apple|facebook)\/(start|connect)$/.exec(
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
      return json(res, { url: result.url });
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
      return json(res, { url: result.url });
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
      return json(res, { ok: true });
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
      return json(res, { ok: true });
    }
    throw new HttpError(404, 'Route not found.');
  }
  return { handle, session, authorize, names, checkOrigin };
}

/** Relay Apple's cross-site POST to a GET that carries the browser's Lax cookies. */
export function appleCallbackLocation(
  form: URLSearchParams,
  pathname: string,
): string {
  const query = new URLSearchParams();
  for (const key of ['state', 'code', 'error']) {
    const values = form.getAll(key);
    if (values.length > 1) throw new HttpError(400, 'Invalid callback.');
    if (values[0]) query.set(key, values[0]);
  }
  // No tokens are exchanged until the GET checks state AND the browser cookie.
  return `${pathname}?${query}`;
}

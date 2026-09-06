import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { connectDatabase } from 'pgstencil/postgres';
import {
  type Time,
  type RandomSource,
  type EmailSender,
  type EmailDev,
} from 'pgstencil';
import { Auth } from './auth.ts';
import type { DB } from './db.generated.ts';
import {
  cookieValues,
  sessionCookie,
  normalizeEmail,
  digest,
  equalDigest,
} from './security.ts';
import {
  page,
  loginPage,
  codePage,
  confirmPage,
  accountPage,
  sendFailurePage,
  escape,
} from './views.ts';
import { devInboxRoutes } from './dev-inbox.ts';
import { OAuth } from './oauth.ts';
import {
  OAuthProviders,
  PROVIDER_LABELS,
  PROVIDER_ORIGINS,
  isProvider,
  type OAuthSettings,
  type OAuthFetch,
} from './oauth-providers.ts';
export interface AppConfig {
  databaseUrl: string;
  time: Time;
  random: RandomSource;
  email: EmailSender;
  secret: string;
  development?: boolean;
  publicOrigin?: string;
  secureCookies?: boolean;
  port?: number;
  /** Supplying the capture inbox mounts /dev/emails; production simply cannot. */
  devInbox?: EmailDev;
  oauth?: OAuthSettings;
  /** Optional transport seam for local protocol tests; no provider credentials are faked by default. */
  oauthFetch?: OAuthFetch;
}
const MAX_BODY_BYTES = 8192;
// Every instance serves the same stylesheet: read it once per process.
let stylesheet: Promise<string> | undefined;
export async function startApp(config: AppConfig) {
  const development = config.development ?? false;
  const secure = config.secureCookies ?? !development;
  if (
    config.publicOrigin &&
    new URL(config.publicOrigin).origin !== config.publicOrigin
  )
    throw new Error(
      'publicOrigin must contain only scheme, host and optional port',
    );
  if (!development && (!secure || !config.publicOrigin?.startsWith('https://')))
    throw new Error(
      'Production requires HTTPS publicOrigin and Secure cookies',
    );
  const css = await (stylesheet ??= readFile(
    new URL('./style.css', import.meta.url),
    'utf8',
  ));
  const db = connectDatabase<DB>(config.databaseUrl);
  const server = createServer();
  // Bind before building anything that needs the origin, so no component has
  // to observe a half-built app through a late-filled thunk.
  try {
    server.listen(config.port ?? 0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    await db.destroy();
    throw error;
  }
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No server address');
    const localOrigin = `http://127.0.0.1:${address.port}`;
    const origin = config.publicOrigin ?? localOrigin;
    const auth = new Auth({
      db,
      time: config.time,
      random: config.random,
      email: config.email,
      secret: config.secret,
      origin,
    });
    const inbox = config.devInbox
      ? devInboxRoutes(config.devInbox, config.time, origin)
      : undefined;
    const showInbox = inbox !== undefined;
    const oauth = new OAuth(
      auth,
      new OAuthProviders(config.oauth ?? {}, config.oauthFetch),
    );
    const methods = oauth.providers.enabled.map((id) => ({
      id,
      label: PROVIDER_LABELS[id],
    }));
    const oauthName = secure ? '__Host-pgstencil-oauth' : 'pgstencil_oauth';
    const sessionName = secure ? '__Host-pgstencil' : 'pgstencil_dev';
    const pendingName = secure
      ? '__Host-pgstencil-pending'
      : 'pgstencil_pending';
    function setCookie(
      res: ServerResponse,
      name: string,
      value: string,
      seconds: number,
    ) {
      // setCookie is the only writer, so the header is always an array.
      const existing = (res.getHeader('set-cookie') as string[]) ?? [];
      res.setHeader('set-cookie', [
        ...existing,
        sessionCookie(name, value, config.time.now(), seconds, secure),
      ]);
    }
    function send(res: ServerResponse, status: number, html: string) {
      res.statusCode = status;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    }
    function fail(
      res: ServerResponse,
      status: number,
      title: string,
      body: string,
    ) {
      send(res, status, page(title, body, showInbox));
    }
    function redirect(res: ServerResponse, path: string) {
      res.statusCode = 303;
      res.setHeader('location', path);
      res.end();
    }
    async function handle(req: IncomingMessage, res: ServerResponse) {
      res.setHeader('cache-control', 'no-store');
      // no-referrer also nulls Origin on native form POSTs. strict-origin
      // preserves CSRF origin checks while never disclosing paths/link tokens.
      res.setHeader('referrer-policy', 'strict-origin');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader(
        'content-security-policy',
        `default-src 'none'; style-src 'self'; form-action 'self'${oauth.providers.enabled.map((provider) => ` ${PROVIDER_ORIGINS[provider]}`).join('')}; base-uri 'none'; frame-ancestors 'none'`,
      );
      const url = new URL(req.url ?? '/', origin);
      const cookies = cookieValues(req.headers.cookie);
      const rawSession = cookies[sessionName];
      const oauthRoute = url.pathname.match(
        /^\/oauth\/([^/]+)\/(start|connect|callback)$/,
      );
      const provider =
        oauthRoute &&
        isProvider(oauthRoute[1]!) &&
        oauth.providers.enabled.includes(oauthRoute[1])
          ? oauthRoute[1]
          : undefined;
      if (oauthRoute && !provider) {
        fail(
          res,
          404,
          'Sign-in method unavailable.',
          '<a href="/login">Return to sign-in</a>',
        );
        return;
      }
      if (req.method === 'GET' && provider && oauthRoute?.[2] === 'callback') {
        const { result, clearCookie } = await oauth.complete(
          provider,
          url,
          cookies[oauthName],
          rawSession,
        );
        if (clearCookie) setCookie(res, oauthName, '', 0);
        if (result.ok) {
          setCookie(res, sessionName, result.session, 24 * 60 * 60);
          setCookie(res, pendingName, '', 0);
          redirect(res, '/account');
        } else {
          send(
            res,
            result.status,
            page(
              'Sign-in not completed.',
              `<p class="error" role="alert">${escape(result.message)}</p><div class="recovery"><a href="/login">Return to sign-in</a><a href="/account">Return to account</a></div>`,
              showInbox,
            ),
          );
        }
        return;
      }
      // Only the routes below that need a flow pay for the lookup, and only once.
      let pendingFlow: ReturnType<Auth['pending']> | undefined;
      const getPending = () =>
        (pendingFlow ??= auth.pending(cookies[pendingName]));
      if (req.method === 'GET' && url.pathname === '/style.css') {
        res.setHeader('content-type', 'text/css; charset=utf-8');
        res.end(css);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        redirect(res, '/login');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        const flow = await auth.newFlow();
        setCookie(res, pendingName, flow.cookie, 30 * 60);
        send(res, 200, loginPage(flow.csrf, showInbox, undefined, methods));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/account') {
        const session = await auth.session(rawSession);
        if (!session) {
          setCookie(res, sessionName, '', 0);
          redirect(res, '/login');
          return;
        }
        const connected = methods.length
          ? await db
              .selectFrom('oauth_identities')
              .select('provider')
              .where('user_id', '=', session.user_id)
              .execute()
          : [];
        send(
          res,
          200,
          accountPage(
            session,
            auth.sessionCsrf(rawSession!),
            showInbox,
            methods.map((method) => ({
              ...method,
              connected: connected.some((row) => row.provider === method.id),
            })),
          ),
        );
        return;
      }
      if (inbox && req.method === 'GET' && inbox(res, url)) return;
      if (req.method === 'GET' && url.pathname === '/login/code') {
        const pending = await getPending();
        if (!pending?.flow.email) {
          redirect(res, '/login');
          return;
        }
        send(res, 200, codePage(pending.flow.email, pending.csrf, showInbox));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/login/link') {
        const pending = await getPending();
        const id = url.searchParams.get('id') ?? '';
        const link = url.searchParams.get('token') ?? '';
        const challenge = pending
          ? await db
              .selectFrom('login_challenges')
              .select(['email', 'flow_id'])
              .where('id', '=', id)
              .executeTakeFirst()
          : undefined;
        if (!pending || challenge?.flow_id !== pending.flow.id) {
          fail(
            res,
            200,
            'Open your original browser.',
            '<p class="intro">Enter the code from your email in the browser where you requested it, or start a new sign-in here.</p><a href="/login">Start a new sign-in</a>',
          );
          return;
        }
        send(
          res,
          200,
          confirmPage(challenge.email, pending.csrf, id, link, showInbox),
        );
        return;
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) {
          fail(
            res,
            403,
            'Request not accepted.',
            '<p>Please return to the sign-in page and try again.</p>',
          );
          return;
        }
        if (
          !req.headers['content-type']?.startsWith(
            'application/x-www-form-urlencoded',
          )
        ) {
          fail(
            res,
            415,
            'Form required.',
            '<p>Please submit the form on this site.</p>',
          );
          return;
        }
        let body = '';
        let received = 0;
        for await (const chunk of req) {
          received += (chunk as Buffer).length;
          if (received > MAX_BODY_BYTES) {
            fail(res, 413, 'Request too large.', '<p>Please try again.</p>');
            return;
          }
          body += String(chunk);
        }
        const form = new URLSearchParams(body);
        const csrf = form.get('csrf') ?? '';
        const source = req.socket.remoteAddress ?? 'unknown';
        if (
          provider &&
          (oauthRoute?.[2] === 'start' || oauthRoute?.[2] === 'connect')
        ) {
          const linking = oauthRoute[2] === 'connect';
          const session = linking ? await auth.session(rawSession) : undefined;
          const pending = linking ? undefined : await getPending();
          const valid = linking
            ? session && equalDigest(session.csrf_hash, digest(csrf))
            : pending && auth.validCsrf(pending, csrf);
          if (!valid) {
            fail(
              res,
              403,
              'Request not accepted.',
              '<p>Return to sign-in or your account and try again.</p>',
            );
            return;
          }
          try {
            const result = await oauth.begin(provider, source, session);
            if (result.ok) {
              setCookie(res, oauthName, result.cookie, result.seconds);
              redirect(res, result.url);
            } else
              send(
                res,
                result.status,
                page(
                  'Sign-in not started.',
                  `<p class="error" role="alert">${escape(result.message)}</p><a href="/login">Return to sign-in</a>`,
                  showInbox,
                ),
              );
          } catch {
            fail(
              res,
              503,
              'Sign-in temporarily unavailable.',
              '<p>Please try again, or sign in with email.</p><a href="/login">Return to sign-in</a>',
            );
          }
          return;
        }
        if (url.pathname === '/logout') {
          const session = await auth.session(rawSession);
          if (!session || !equalDigest(session.csrf_hash, digest(csrf))) {
            fail(
              res,
              403,
              'Request not accepted.',
              '<p>Return to your account and try again.</p>',
            );
            return;
          }
          await auth.logout(rawSession!);
          setCookie(res, sessionName, '', 0);
          redirect(res, '/login');
          return;
        }
        const pending = await getPending();
        if (!pending || !auth.validCsrf(pending, csrf)) {
          fail(
            res,
            403,
            'Start a new sign-in.',
            '<p>This sign-in request is no longer available.</p><a href="/login">Return to sign-in</a>',
          );
          return;
        }
        if (url.pathname === '/login' || url.pathname === '/login/resend') {
          const email = normalizeEmail(
            url.pathname === '/login/resend'
              ? (pending.flow.email ?? '')
              : (form.get('email') ?? ''),
          );
          if (!email) {
            send(
              res,
              400,
              loginPage(
                pending.csrf,
                showInbox,
                'Enter a valid email address.',
                methods,
              ),
            );
            return;
          }
          const result = await auth.send(pending, email, source);
          if (result.ok) redirect(res, '/login/code');
          else
            send(
              res,
              result.status,
              sendFailurePage(email, pending.csrf, showInbox, result.message),
            );
          return;
        }
        if (url.pathname === '/login/code' || url.pathname === '/login/link') {
          const method = url.pathname === '/login/code' ? 'code' : 'link';
          const result = await auth.verify(
            pending,
            method,
            form.get(method === 'code' ? 'code' : 'token') ?? '',
            form.get('id') ?? undefined,
            source,
            rawSession,
          );
          if (result.ok) {
            setCookie(res, sessionName, result.session, 24 * 60 * 60);
            setCookie(res, pendingName, '', 0);
            redirect(res, '/account');
          } else
            send(
              res,
              result.status,
              codePage(
                pending.flow.email ?? '',
                pending.csrf,
                showInbox,
                result.message,
              ),
            );
          return;
        }
      }
      fail(
        res,
        404,
        'Page not found.',
        '<a href="/login">Return to sign-in</a>',
      );
    }
    server.on('request', (req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent)
          fail(res, 500, 'Something went wrong.', '<p>Please try again.</p>');
        else res.end();
      });
    });
    let closed = false;
    return {
      origin: localOrigin,
      publicOrigin: origin,
      db,
      auth,
      sessionName,
      pendingName,
      oauthName,
      async close() {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await db.destroy();
      },
    };
  } catch (error) {
    server.close();
    await db.destroy();
    throw error;
  }
}
export type LoginApp = Awaited<ReturnType<typeof startApp>>;

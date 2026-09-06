import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { connectDatabase } from 'pgstencil/database';
import {
  type Time,
  type RandomSource,
  type EmailSender,
  EmailDev,
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
  escape,
  date,
  hidden,
  loginEmail,
} from './views.ts';
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
}
export async function startApp(config: AppConfig) {
  const development = config.development === true;
  const secure = config.secureCookies ?? !development;
  if (!development && (!secure || !config.publicOrigin?.startsWith('https://')))
    throw new Error(
      'Production requires HTTPS publicOrigin and Secure cookies',
    );
  const db = connectDatabase<DB>(config.databaseUrl);
  let origin = config.publicOrigin ?? '';
  const auth = new Auth({
    db,
    time: config.time,
    random: config.random,
    email: config.email,
    secret: config.secret,
    origin: () => origin,
  });
  const sessionName = secure ? '__Host-pgstencil' : 'pgstencil_dev';
  const pendingName = secure ? '__Host-pgstencil-pending' : 'pgstencil_pending';
  const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          page(
            'Something went wrong.',
            '<p>Please try again.</p>',
            development,
          ),
        );
      } else res.end();
    });
  });
  function setCookie(
    res: ServerResponse,
    name: string,
    value: string,
    seconds: number,
  ) {
    const existing = res.getHeader('set-cookie');
    const cookies = Array.isArray(existing)
      ? existing
      : existing
        ? [String(existing)]
        : [];
    res.setHeader('set-cookie', [
      ...cookies,
      sessionCookie(name, value, config.time.now(), seconds, secure),
    ]);
  }
  function send(res: ServerResponse, status: number, html: string) {
    res.statusCode = status;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  }
  function redirect(res: ServerResponse, path: string) {
    res.statusCode = 303;
    res.setHeader('location', path);
    res.end();
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const url = new URL(req.url ?? '/', origin);
    const cookies = cookieValues(req.headers.cookie);
    const rawSession = cookies[sessionName];
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
      const pending = await auth.newFlow();
      setCookie(res, pendingName, pending.cookie, 30 * 60);
      send(res, 200, loginPage(pending.csrf, undefined, development));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/account') {
      const session = await auth.session(rawSession);
      if (!session) {
        setCookie(res, sessionName, '', 0);
        redirect(res, '/login');
        return;
      }
      send(
        res,
        200,
        page(
          'You’re signed in.',
          `<p class="intro">Welcome, <strong>${escape(session.email)}</strong>.</p><dl><dt>Signed in</dt><dd>${escape(date(session.created_at))}</dd><dt>Session expires</dt><dd>${escape(date(session.expires_at))}</dd></dl><form method="post" action="/logout">${hidden('csrf', auth.sessionCsrf(rawSession!))}<button type="submit">Sign out</button></form>`,
          development,
        ),
      );
      return;
    }
    if (
      development &&
      config.email instanceof EmailDev &&
      req.method === 'GET' &&
      url.pathname.startsWith('/dev/emails')
    ) {
      const messages = config.email.all();
      if (url.pathname === '/dev/emails') {
        send(
          res,
          200,
          page(
            'Local inbox.',
            `<p class="intro">Email sent by this application appears here.</p><ul class="messages">${messages.map((m, i) => `<li><a href="/dev/emails/${i}">${escape(m.subject)}</a><br>${escape(m.to.join(', '))}<br><small>${escape(m.capturedAt)}</small></li>`).join('') || '<li>No messages yet. Request a sign-in code to get started.</li>'}</ul><h2>Templates</h2><a href="/dev/emails/template">Sign-in email</a>`,
            true,
          ),
        );
        return;
      }
      const key = url.pathname.split('/')[3];
      const message =
        key === 'template'
          ? loginEmail(
              'you@example.com',
              '12345678',
              `${origin}/login`,
              new Date(config.time.now().getTime() + 600000),
            )
          : messages[Number(key)];
      if (message) {
        if (url.searchParams.get('view') === 'text') {
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(message.text);
        } else send(res, 200, message.html);
        return;
      }
    }
    const pending = await auth.pending(cookies[pendingName]);
    if (req.method === 'GET' && url.pathname === '/login/code') {
      if (!pending?.flow.email) {
        redirect(res, '/login');
        return;
      }
      send(
        res,
        200,
        codePage(pending.flow.email, pending.csrf, undefined, development),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/login/link') {
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
        send(
          res,
          200,
          page(
            'Open your original browser.',
            '<p class="intro">Enter the code from your email in the browser where you requested it, or start a new sign-in here.</p><a href="/login">Start a new sign-in</a>',
            development,
          ),
        );
        return;
      }
      send(
        res,
        200,
        confirmPage(challenge.email, pending.csrf, id, link, development),
      );
      return;
    }
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) {
        send(
          res,
          403,
          page(
            'Request not accepted.',
            '<p>Please return to the sign-in page and try again.</p>',
            development,
          ),
        );
        return;
      }
      if (
        !req.headers['content-type']?.startsWith(
          'application/x-www-form-urlencoded',
        )
      ) {
        send(
          res,
          415,
          page(
            'Form required.',
            '<p>Please submit the form on this site.</p>',
            development,
          ),
        );
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 8192) {
          send(
            res,
            413,
            page('Request too large.', '<p>Please try again.</p>', development),
          );
          return;
        }
      }
      const form = new URLSearchParams(body);
      const csrf = form.get('csrf') ?? '';
      const source = req.socket.remoteAddress ?? 'unknown';
      if (url.pathname === '/logout') {
        const session = await auth.session(rawSession);
        if (!session || !equalDigest(session.csrf_hash, digest(csrf))) {
          send(
            res,
            403,
            page(
              'Request not accepted.',
              '<p>Return to your account and try again.</p>',
              development,
            ),
          );
          return;
        }
        await auth.logout(rawSession!);
        setCookie(res, sessionName, '', 0);
        redirect(res, '/login');
        return;
      }
      if (!pending || !auth.validCsrf(pending, csrf)) {
        send(
          res,
          403,
          page(
            'Start a new sign-in.',
            '<p>This sign-in request is no longer available.</p><a href="/login">Return to sign-in</a>',
            development,
          ),
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
              'Enter a valid email address.',
              development,
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
            codePage(email, pending.csrf, result.message, development),
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
              result.message,
              development,
            ),
          );
        return;
      }
    }
    send(
      res,
      404,
      page(
        'Page not found.',
        '<a href="/login">Return to sign-in</a>',
        development,
      ),
    );
  }
  try {
    server.listen(config.port ?? 0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    await db.destroy();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No server address');
  const localOrigin = `http://127.0.0.1:${address.port}`;
  origin = config.publicOrigin ?? localOrigin;
  let closed = false;
  return {
    origin: localOrigin,
    publicOrigin: origin,
    db,
    auth,
    sessionName,
    pendingName,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await db.destroy();
    },
  };
}
export type LoginApp = Awaited<ReturnType<typeof startApp>>;

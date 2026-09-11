import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { Hono } from 'hono';
import { connectDatabase } from 'pgstencil/postgres';
import type { EmailSender } from 'pgstencil';
import { keyed, protectAuth, publicAuthResponse } from './security.ts';

export function authOptions(options: {
  database: ReturnType<typeof connectDatabase>;
  origin: string;
  secret: string;
  email: EmailSender;
  ipAddressHeaders?: string[];
  sessionPolicy?: 'single' | 'multiple';
}): BetterAuthOptions {
  const secure = options.origin.startsWith('https:');
  return {
    appName: 'pgstencil Better Auth example',
    baseURL: options.origin,
    secret: options.secret,
    database: { db: options.database, type: 'postgres', transaction: true },
    telemetry: { enabled: false },
    // Keep production security enabled under NODE_ENV=test as well.
    advanced: {
      useSecureCookies: false, // Names below carry __Host- themselves; avoid a second prefix.
      cookiePrefix: secure ? '__Host-pgstencil' : 'pgstencil',
      defaultCookieAttributes: {
        secure,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: {
        ipAddressHeaders: options.ipAddressHeaders ?? ['x-pgstencil-client-ip'],
      },
    },
    // Workers are request-scoped; an in-memory limiter would reset every request.
    rateLimit: { enabled: true, storage: 'database' },
    session: {
      additionalFields: {
        singleSession: {
          type: 'boolean',
          required: true,
          defaultValue: false,
          input: false,
          returned: false,
        },
      },
      freshAge: 10 * 60,
      expiresIn: 24 * 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              singleSession: options.sessionPolicy === 'single',
            },
          }),
        },
      },
    },
    account: { accountLinking: { disableImplicitLinking: true } },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: {
          hash: async (otp) => keyed(options.secret, 'email-otp', otp),
        },
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in')
            throw new Error('This example only supports sign-in email');
          await options.email.send({
            from: 'signin@example.test',
            to: [email],
            subject: 'Your sign-in code',
            text: `Your sign-in code is ${otp}. It expires in 10 minutes.`,
            html: `<p>Your sign-in code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
          });
        },
      }),
    ],
  };
}

export function createEmailApp(options: {
  databaseUrl: string;
  origin: string;
  secret: string;
  email: EmailSender;
  ipAddressHeaders?: string[];
  sessionPolicy?: 'single' | 'multiple';
}) {
  const db = connectDatabase(options.databaseUrl);
  const auth = betterAuth(authOptions({ ...options, database: db }));
  const app = new Hono();
  protectAuth(app, { ...options, database: db });
  app.on(['POST', 'GET'], '/api/auth/*', async (c) =>
    publicAuthResponse(await auth.handler(c.req.raw)),
  );
  app.get('/auth.js', (c) =>
    c.body(loginScript, 200, {
      'content-type': 'text/javascript; charset=utf-8',
    }),
  );
  app.get('/', (c) => c.html(loginHtml));
  return { app, auth, db, close: () => db.destroy() };
}

const loginHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Better Auth email example</title>
<main><h1>Sign in</h1>
<form id="send"><label>Email <input name="email" type="email" required></label><button>Email a code</button></form>
<form id="verify" hidden><label>Code <input name="otp" inputmode="numeric" autocomplete="one-time-code" required></label><button>Sign in</button></form>
<button id="logout" hidden>Sign out</button><p id="status" role="status"></p></main>
<script type="module" src="/auth.js"></script></html>`;

const loginScript = `
const send = document.querySelector('#send'), verify = document.querySelector('#verify');
const status = document.querySelector('#status'), logout = document.querySelector('#logout');
let csrf;
const post = async (path, body) => {
  const response = await fetch('/api/auth/' + path, {method:'POST', headers:{'content-type':'application/json', 'x-csrf-token':csrf}, body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Request failed');
  return data;
};
send.onsubmit = async (event) => {
  event.preventDefault();
  try { await post('email-otp/send-verification-otp', {email:send.email.value, type:'sign-in'}); verify.hidden=false; status.textContent='Check your email for a code.'; }
  catch (error) { status.textContent=error.message; }
};
verify.onsubmit = async (event) => {
  event.preventDefault();
  try { await post('sign-in/email-otp', {email:send.email.value, otp:verify.otp.value}); await session(); }
  catch (error) { status.textContent=error.message; }
};
logout.onclick = async () => { try { await post('sign-out', {}); await session(); } catch (error) { status.textContent=error.message; } };
async function session() {
  const data = await (await fetch('/api/auth/get-session')).json();
  status.textContent=data ? 'Signed in as ' + data.user.email : 'Signed out';
  send.hidden=!!data; verify.hidden=true; logout.hidden=!data;
}
csrf = (await (await fetch('/api/auth/csrf')).json()).csrf;
await session();`;

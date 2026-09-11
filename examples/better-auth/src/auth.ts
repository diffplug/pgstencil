import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { Hono } from 'hono';
import { connectDatabase } from 'pgstencil/postgres';
import type { EmailSender } from 'pgstencil';

export function authOptions(options: {
  database: ReturnType<typeof connectDatabase>;
  origin: string;
  secret: string;
  email: EmailSender;
  ipAddressHeaders?: string[];
}): BetterAuthOptions {
  return {
    appName: 'pgstencil Better Auth example',
    baseURL: options.origin,
    secret: options.secret,
    database: { db: options.database, type: 'postgres', transaction: true },
    telemetry: { enabled: false },
    // Keep production security enabled under NODE_ENV=test as well.
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: {
        ipAddressHeaders: options.ipAddressHeaders ?? ['x-pgstencil-client-ip'],
      },
    },
    // Workers are request-scoped; an in-memory limiter would reset every request.
    rateLimit: { enabled: true, storage: 'database' },
    session: {
      expiresIn: 24 * 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { disableImplicitLinking: true } },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 600,
        allowedAttempts: 3,
        storeOTP: 'hashed',
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
}) {
  const db = connectDatabase(options.databaseUrl);
  const auth = betterAuth(authOptions({ ...options, database: db }));
  const app = new Hono();
  app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  app.get('/', (c) => c.html(loginHtml));
  return { app, auth, db, close: () => db.destroy() };
}

const loginHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Better Auth email example</title>
<main><h1>Sign in</h1>
<form id="send"><label>Email <input name="email" type="email" required></label><button>Email a code</button></form>
<form id="verify" hidden><label>Code <input name="otp" inputmode="numeric" autocomplete="one-time-code" required></label><button>Sign in</button></form>
<button id="logout" hidden>Sign out</button><p id="status" role="status"></p></main>
<script type="module">
const send = document.querySelector('#send'), verify = document.querySelector('#verify');
const status = document.querySelector('#status'), logout = document.querySelector('#logout');
const post = async (path, body) => {
  const response = await fetch('/api/auth/' + path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
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
await session();
</script></html>`;

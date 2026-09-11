import { createAuthApp } from '@pgstencil/auth/better-auth';
export { authOptions } from '@pgstencil/auth/better-auth';
export function createEmailApp(options: Parameters<typeof createAuthApp>[0]) {
  const result = createAuthApp(options);
  result.app.get('/auth.js', (c) =>
    c.body(loginScript, 200, {
      'content-type': 'text/javascript; charset=utf-8',
    }),
  );
  result.app.get('/', (c) => c.html(loginHtml));
  return result;
}

const loginHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Better Auth email example</title>
<main><h1>Sign in</h1>
<form id="send"><label>Email <input name="email" type="email" required></label><button>Email a code</button></form>
<form id="verify" hidden><label>Code <input name="otp" inputmode="numeric" autocomplete="one-time-code" required></label><button>Sign in</button></form>
<div id="providers"></div><button id="logout" hidden>Sign out</button><p id="status" role="status"></p></main>
<script type="module" src="/auth.js"></script></html>`;

const loginScript = `
const send = document.querySelector('#send'), verify = document.querySelector('#verify');
const status = document.querySelector('#status'), logout = document.querySelector('#logout');
let csrf, signedIn = false;
const providerNames = {google:'Google', apple:'Apple', facebook:'Facebook', github:'GitHub'};
const enabledProviders = await (await fetch('/api/providers')).json();
const showProviders = async () => {
  const container = document.querySelector('#providers'); container.replaceChildren();
  const linked = signedIn ? await (await fetch('/api/auth/list-accounts')).json() : [];
  for (const provider of enabledProviders) {
    const connected = linked.some(account => account.providerId === provider);
    const button = document.createElement('button');
    button.textContent = (signedIn ? (connected ? 'Connected: ' : 'Connect ') : 'Continue with ') + providerNames[provider];
    button.disabled = connected;
    button.onclick = async () => { try { const data = await post(signedIn ? 'link-social' : 'sign-in/social', {provider}); location.assign(data.url); } catch(error) {status.textContent = error.message;} };
    container.append(button);
  }
};
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
  signedIn=!!data; send.hidden=!!data; verify.hidden=true; logout.hidden=!data;
  await showProviders();
}
csrf = (await (await fetch('/api/auth/csrf')).json()).csrf;
await session();
if (new URL(location.href).searchParams.has('error')) { status.textContent = 'Could not sign in. Try again, or sign in by email and connect this provider.'; history.replaceState(null, '', '/'); }`;

/*
 * Operate: a quiet, server-rendered sign-in form. The approved login flow owns
 * the layout: one heading, one task, clear errors and a visible recovery path.
 * Palette: warm paper, dark forest ink, restrained green controls.
 */
import type { EmailMessage } from 'pgstencil';
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}
// Locale resolution is the expensive part; build the formatter once.
const UTC_FORMAT = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
export function date(value: Date): string {
  return UTC_FORMAT.format(value) + ' UTC';
}
export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
}
export function page(title: string, body: string, showInbox: boolean): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · pgstencil</title><link rel="stylesheet" href="/style.css"></head>
<body>
<!-- THESIS: One sign-in task with clear recovery. OWN-WORLD: Warm paper and forest native forms. STORY: Email, verify, account, logout. FIRST VIEWPORT: Heading, instruction, labeled control, submit, recovery. FORM: Native HTML, no client JavaScript; seed 93f1c640. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md. -->
<header><a class="wordmark" href="/login" aria-label="pgstencil home">pgstencil<span aria-hidden="true">.</span></a>${showInbox ? '<a class="dev-link" href="/dev/emails">Local inbox</a>' : ''}</header>
<main id="main"><h1>${escape(title)}</h1>${body}</main>
<footer>pgstencil <span>Simple sign-in. Your email is your key.</span></footer>
</body></html>`;
}
export function errorMessage(message?: string): string {
  return message ? `<p class="error" role="alert">${escape(message)}</p>` : '';
}
export interface SignInMethod {
  id: string;
  label: string;
  connected?: boolean;
}
function providerForms(
  methods: readonly SignInMethod[],
  csrf: string,
  connecting: boolean,
): string {
  if (!methods.length) return '';
  return `<fieldset class="providers"><legend>${connecting ? 'Connected sign-in methods' : 'Or continue with'}</legend>${methods
    .map((method) =>
      method.connected
        ? `<p>${escape(method.label)} is connected.</p>`
        : `<form method="post" action="/oauth/${escape(method.id)}/${connecting ? 'connect' : 'start'}">${hidden('csrf', csrf)}<button class="provider-button" type="submit">${connecting ? 'Connect' : 'Continue with'} ${escape(method.label)}</button></form>`,
    )
    .join(
      '',
    )}${connecting ? '<p class="note">To connect a provider, sign in within the last five minutes and use the same verified email address.</p>' : ''}</fieldset>`;
}
export function loginPage(
  csrf: string,
  showInbox: boolean,
  providers: readonly SignInMethod[],
  message?: string,
): string {
  return page(
    'Welcome in.',
    `<p class="intro">Sign in with your email. We’ll send you a code and a link—use whichever you prefer.</p>${errorMessage(message)}
<form method="post" action="/login">${hidden('csrf', csrf)}<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" required><button type="submit">Send sign-in code</button></form>
<p class="note">New here? Your account is created when you verify your email.</p>${providerForms(providers, csrf, false)}`,
    showInbox,
  );
}
export function codePage(
  email: string,
  csrf: string,
  showInbox: boolean,
  message?: string,
): string {
  return page(
    'Check your email.',
    `<p class="intro">Enter the code we sent to <strong>${escape(email)}</strong>, or open the sign-in link in that email.</p>${errorMessage(message)}
<form method="post" action="/login/code">${hidden('csrf', csrf)}<label for="code">Sign-in code</label><input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9\\s]{8,16}" maxlength="16" placeholder="0000 0000" aria-describedby="expiry" required><p id="expiry" class="field-note">Your code expires in 10 minutes.</p><button type="submit">Verify code</button></form>
<div class="recovery"><form method="post" action="/login/resend">${hidden('csrf', csrf)}<button class="text-button" type="submit">Send a new code</button></form><a href="/login">Use another email</a></div><p class="note">You can request another code after one minute. Only the newest code will work.</p>`,
    showInbox,
  );
}
export function confirmPage(
  email: string,
  csrf: string,
  id: string,
  linkToken: string,
  showInbox: boolean,
): string {
  return page(
    'Ready to sign in?',
    `<p class="intro">Continue as <strong>${escape(email)}</strong>.</p><form method="post" action="/login/link">${hidden('csrf', csrf)}${hidden('id', id)}${hidden('token', linkToken)}<button type="submit">Confirm sign-in</button></form><p class="note">This link works once, in the browser where you requested it.</p><a href="/login">Use another email</a>`,
    showInbox,
  );
}
export function sendFailurePage(
  email: string,
  csrf: string,
  showInbox: boolean,
  message: string,
): string {
  return page(
    'No new email sent.',
    `<p class="intro">We couldn’t send a new sign-in email to <strong>${escape(email)}</strong>.</p>${errorMessage(message)}<form method="post" action="/login">${hidden('csrf', csrf)}${hidden('email', email)}<button type="submit">Try sending again</button></form><div class="recovery"><a href="/login/code">Enter an existing code</a><a href="/login">Use another email</a></div>`,
    showInbox,
  );
}
export function accountPage(
  account: { email: string; created_at: Date; expires_at: Date },
  csrf: string,
  showInbox: boolean,
  providers: readonly SignInMethod[],
  billing = false,
): string {
  return page(
    'You’re signed in.',
    `<p class="intro">Welcome, <strong>${escape(account.email)}</strong>.</p><dl><dt>Signed in</dt><dd>${escape(date(account.created_at))}</dd><dt>Session expires</dt><dd>${escape(date(account.expires_at))}</dd></dl><form method="post" action="/logout">${hidden('csrf', csrf)}<button type="submit">Sign out</button></form>${providerForms(providers, csrf, true)}${billing ? '<p><a href="/billing">Billing and subscription</a></p>' : ''}`,
    showInbox,
  );
}
export function loginEmail(
  email: string,
  code: string,
  link: string,
  expiresAt: Date,
): EmailMessage {
  const display = `${code.slice(0, 4)} ${code.slice(4)}`;
  return {
    from: 'pgstencil <signin@example.test>',
    to: [email],
    subject: 'Your pgstencil sign-in code',
    text: `Your sign-in code is ${display}.\n\nOr sign in using this link: ${link}\n\nExpires ${date(expiresAt)}. Open the link in the browser where you requested it, or enter this code there.\n\nIf you didn’t request this email, you can ignore it.`,
    html: `<html lang="en"><body><h1>Your sign-in code</h1><p>Enter this code in the browser where you requested it:</p><p><strong>${display}</strong></p><p>Or <a href="${escape(link)}">sign in to pgstencil</a>.</p><p>Expires ${escape(date(expiresAt))}. Your code and link can only be used once.</p><p>If you didn’t request this email, you can ignore it.</p></body></html>`,
  };
}

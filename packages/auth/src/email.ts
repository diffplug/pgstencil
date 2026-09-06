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

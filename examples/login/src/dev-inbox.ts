import type { ServerResponse } from 'node:http';
import type { EmailDev, Time } from 'pgstencil';
import { escape, page, loginEmail } from './views.ts';
/**
 * The local inbox is mounted only where an EmailDev exists, so a production
 * composition cannot reach it — no runtime mode check guards these routes.
 */
export function devInboxRoutes(email: EmailDev, time: Time, origin: string) {
  return (res: ServerResponse, url: URL): boolean => {
    if (!url.pathname.startsWith('/dev/emails')) return false;
    const messages = email.all();
    if (url.pathname === '/dev/emails') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        page(
          'Local inbox.',
          `<p class="intro">Email sent by this application appears here.</p><ul class="messages">${messages.map((m, i) => `<li><a href="/dev/emails/${i}">${escape(m.subject)}</a><br>${escape(m.to.join(', '))}<br><small>${escape(m.capturedAt)}</small></li>`).join('') || '<li>No messages yet. Request a sign-in code to get started.</li>'}</ul><h2>Templates</h2><a href="/dev/emails/template">Sign-in email</a>`,
          true,
        ),
      );
      return true;
    }
    const key = url.pathname.split('/')[3];
    const message =
      key === 'template'
        ? loginEmail(
            'you@example.com',
            '12345678',
            `${origin}/login`,
            new Date(time.now().getTime() + 600000),
          )
        : messages[Number(key)];
    if (!message) return false;
    if (url.searchParams.get('view') === 'text') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(message.text);
    } else {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(message.html);
    }
    return true;
  };
}

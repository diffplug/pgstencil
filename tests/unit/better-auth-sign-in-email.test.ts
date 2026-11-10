import { test, expect } from 'vitest';
import { escapeHtml } from '../../packages/pgstencil/src/index.ts';
import { defaultSignInEmail } from '../../packages/auth/src/better-auth.ts';
import { signInSender } from '../../packages/auth/src/better-auth-email.ts';

test('escapeHtml escapes the five HTML metacharacters and stringifies anything', () => {
  expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
    '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
  );
  expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  expect(escapeHtml(10)).toBe('10');
  expect(escapeHtml(null)).toBe('null');
  expect(escapeHtml(undefined)).toBe('undefined');
});

const input = {
  email: 'alice@example.test',
  otp: '12345678',
  expiresInMinutes: 10,
  from: 'signin@app.example.test',
};

test('the default sign-in email keeps its wording and sender', () => {
  expect(defaultSignInEmail(input)).toEqual({
    from: 'signin@app.example.test',
    to: ['alice@example.test'],
    subject: 'Your sign-in code',
    text: 'Your sign-in code is 12345678. It expires in 10 minutes.',
    html: '<p>Your sign-in code is <strong>12345678</strong>.</p><p>It expires in 10 minutes.</p>',
  });
});

test('the default sign-in email puts appName in the subject only, never raw in HTML', () => {
  const appName = `<img src=x onerror="alert('x')">&`;
  const message = defaultSignInEmail({ ...input, appName });
  expect(message.subject).toBe(`Your ${appName} sign-in code`);
  expect(message.text).toBe(
    'Your sign-in code is 12345678. It expires in 10 minutes.',
  );
  expect(message.html).toBe(
    '<p>Your sign-in code is <strong>12345678</strong>.</p><p>It expires in 10 minutes.</p>',
  );
  expect(message.html).not.toContain('<img');
});

test('the default sign-in email escapes every value it places in HTML', () => {
  const message = defaultSignInEmail({ ...input, otp: '<b>&"\'</b>' });
  expect(message.html).toBe(
    '<p>Your sign-in code is <strong>&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</strong>.</p><p>It expires in 10 minutes.</p>',
  );
});

test('the default sender is signin@ the origin hostname, or an address literal for an IP origin', () => {
  for (const [origin, sender] of [
    ['https://app.example.test', 'signin@app.example.test'],
    ['http://localhost:3000', 'signin@localhost'],
    ['https://127.0.0.1', 'signin@[127.0.0.1]'],
    ['http://127.0.0.1:8787', 'signin@[127.0.0.1]'],
    ['http://[::1]:3000', 'signin@[IPv6:::1]'],
    ['https://[2001:db8::1]', 'signin@[IPv6:2001:db8::1]'],
    // A hostname that only starts with digits is still a domain.
    ['https://1.example.test', 'signin@1.example.test'],
  ] as const)
    expect(signInSender(undefined, origin), origin).toBe(sender);
});

test('a non-blank emailFrom is the sender, trimmed; a blank one counts as omitted', () => {
  const origin = 'https://app.example.test';
  expect(signInSender('App <hello@mail.example.test>', origin)).toBe(
    'App <hello@mail.example.test>',
  );
  expect(signInSender('  App <hello@mail.example.test>\n', origin)).toBe(
    'App <hello@mail.example.test>',
  );
  for (const blank of ['', ' ', '\t\n'])
    expect(signInSender(blank, origin), JSON.stringify(blank)).toBe(
      'signin@app.example.test',
    );
  expect(signInSender(' ', 'https://127.0.0.1')).toBe('signin@[127.0.0.1]');
});

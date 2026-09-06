import { test, expect } from 'vitest';
import {
  htmlToMarkdown,
  captureResponse,
  stableJson,
  captureEmail,
} from '../../packages/pgstencil/src/snapshots.ts';

test('Markdown lenses retain meaningful tables, links, fields, images and preformatted text', () => {
  const markdown = htmlToMarkdown(
    '<main><h1>Ignored</h1><section class="selfie"><h2>Receipt</h2><div class="selfie-exclude">Noise</div><input type="hidden" name="csrf" value="secret"><label>Email<input name="email" value="alice@example.test"></label><button>Continue</button><table><tr><th>Item</th><th>Cost</th></tr><tr><td><a href="/item">Book</a></td><td>12 | 13</td></tr></table><pre><code>  keep  spaces\nnext</code></pre><img src="/cover.png" alt="Cover"><iframe title="Preview" src="/preview"></iframe></section></main>',
  );
  expect(markdown).toContain('## Receipt');
  expect(markdown).not.toMatch(/Ignored|Noise|secret/);
  expect(markdown).toContain('\\[email: alice@example.test\\]');
  expect(markdown).toContain(
    '| Item | Cost |\n| --- | --- |\n| [Book](/item) | 12 \\| 13 |',
  );
  expect(markdown).toContain('  keep  spaces\nnext');
  expect(markdown).toContain('![Cover](/cover.png)');
  expect(markdown).toContain('[Preview](/preview)');
});

test('capture preserves raw HTML, query order, security attributes and email metadata', () => {
  const html = '<pre>  spaces\n &amp; entities</pre>';
  const response = captureResponse(
    {
      status: 303,
      text: html,
      headers: {
        date: 'machine-clock',
        location: 'http://localhost:123/account',
        'set-cookie': [
          'session=abc; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 02 Jan 2020 00:00:00 GMT',
        ],
        'content-security-policy': "default-src 'none'",
      },
    },
    'http://localhost:123',
  );
  expect(response.html).toBe(html);
  expect(response.http).not.toContain('machine-clock');
  expect(response.http).toContain('https://pgstencil.test/account');
  expect(response.http).toContain(
    'HttpOnly; Secure; SameSite=Lax; Expires=Thu, 02 Jan 2020',
  );
  expect(stableJson([{ z: 1n, a: null }, { z: 0n }])).toBe(
    '[\n  {\n    "a": null,\n    "z": "1n"\n  },\n  {\n    "z": "0n"\n  }\n]\n',
  );
  expect(
    captureEmail(
      {
        from: 'from@example.test',
        to: ['to@example.test'],
        cc: ['cc@example.test'],
        replyTo: 'reply@example.test',
        headers: { 'X-App': 'yes' },
        subject: 'Hi',
        text: 'hello',
        html: '<p>hello</p>',
        capturedAt: '2020-01-01T00:00:00.000Z',
      },
      'http://localhost:123',
    ),
  ).toContain('"replyTo": "reply@example.test"');
});

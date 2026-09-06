import { load } from 'cheerio';
import TurndownService from 'turndown';
import type { CapturedEmail } from './email.ts';
export function stableJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (typeof item === 'bigint') return `${item}n`;
        if (
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.getPrototypeOf(item) === Object.prototype
        )
          return Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
          );
        return item;
      },
      2,
    ) + '\n'
  );
}
export function normalizeOrigin(text: string, origin: string): string {
  return text.replaceAll(origin, 'https://pgstencil.test');
}
export function htmlToMarkdown(html: string): string {
  const $ = load(html);
  $('.selfie-exclude,script,style,link,meta').remove();
  $('input[type="hidden"]').remove();
  $('input').each((_index, element) => {
    const field = $(element);
    const label = field.attr('aria-label') ?? field.attr('name') ?? 'input';
    field.replaceWith(
      $('<p>').text(
        `[${label}: ${field.attr('value') ?? field.attr('placeholder') ?? ''}]`,
      ),
    );
  });
  $('button').each((_index, element) => {
    const button = $(element);
    button.replaceWith($('<p>').text(`[${button.text().trim()}]`));
  });
  const selected = $('.selfie').length
    ? $('.selfie').last().html()
    : $('main').length
      ? $('main').html()
      : $('body').html();
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  turndown.addRule('tables', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = load(node.outerHTML);
      return (
        '\n\n' +
        table('tr')
          .map(
            (_i, row) =>
              '| ' +
              table(row)
                .find('th,td')
                .map((_j, cell) => table(cell).text().replaceAll('|', '\\|'))
                .get()
                .join(' | ') +
              ' |',
          )
          .get()
          .join('\n') +
        '\n\n'
      );
    },
  });
  return turndown.turndown(selected ?? '').trim() + '\n';
}
export interface SnapshotResponse {
  status: number;
  text: string;
  headers: Record<string, unknown>;
}
export function captureResponse(
  response: SnapshotResponse,
  origin: string,
): { html: string; markdown: string; http: string } {
  const headers = Object.fromEntries(
    Object.entries(response.headers)
      .filter(
        ([key]) =>
          ![
            'date',
            'connection',
            'keep-alive',
            'content-length',
            'transfer-encoding',
          ].includes(key.toLowerCase()),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    html: normalizeOrigin(response.text, origin),
    markdown: normalizeOrigin(htmlToMarkdown(response.text), origin),
    http: normalizeOrigin(
      stableJson({ status: response.status, headers }),
      origin,
    ),
  };
}
export function captureEmail(email: CapturedEmail, origin: string): string {
  return normalizeOrigin(
    `# ${email.subject}\n\n${stableJson({ from: email.from, to: email.to, capturedAt: email.capturedAt })}\n## Plaintext\n\n${email.text}\n\n## Markdown\n\n${htmlToMarkdown(email.html)}\n## HTML\n\n${email.html}\n`,
    origin,
  );
}

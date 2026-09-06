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
  return text
    .replaceAll(origin, 'https://pgstencil.test')
    .replaceAll(
      encodeURIComponent(origin),
      encodeURIComponent('https://pgstencil.test'),
    );
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
  // .html() is null for an empty selection, so each fallback is just ??.
  const selected =
    $('.selfie').last().html() ?? $('main').html() ?? $('body').html();
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  turndown.addRule('tables', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = load(node.outerHTML);
      const rows = table('tr')
        .map(
          (_i, row) =>
            '| ' +
            table(row)
              .find('th,td')
              .map((_j, cell) =>
                turndown
                  .turndown(table(cell).html() ?? '')
                  .trim()
                  .replaceAll('|', '\\|')
                  .replaceAll('\n', '<br>'),
              )
              .get()
              .join(' | ') +
            ' |',
        )
        .get();
      if (!rows.length) return '';
      const columns = table('tr').first().find('th,td').length;
      const separator =
        '| ' + Array.from({ length: columns }, () => '---').join(' | ') + ' |';
      // Treat the first row as the header, matching GitHub Markdown tables.
      return (
        '\n\n' + [rows[0], separator, ...rows.slice(1)].join('\n') + '\n\n'
      );
    },
  });
  turndown.addRule('frames', {
    filter: 'iframe',
    replacement: (_content, node) => {
      return `\n\n[${node.getAttribute('title') ?? 'Embedded content'}](${node.getAttribute('src') ?? ''})\n\n`;
    },
  });
  return turndown.turndown(selected ?? '').trim() + '\n';
}
/** Headers whose values change per run and would defeat snapshot comparison. */
const VOLATILE_HEADERS = new Set([
  'date',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);
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
      .filter(([key]) => !VOLATILE_HEADERS.has(key.toLowerCase()))
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
  const { html, text, subject, ...metadata } = email;
  return normalizeOrigin(
    `# ${subject}\n\n${stableJson(metadata)}\n## Plaintext\n\n${text}\n\n## Markdown\n\n${htmlToMarkdown(html)}\n## HTML\n\n${html}\n`,
    origin,
  );
}

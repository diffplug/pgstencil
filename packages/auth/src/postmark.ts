import type { EmailSender } from 'pgstencil';

class EmailDeliveryError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly providerCode?: number,
  ) {
    super('Email delivery failed');
  }
}

/** Postmark's numeric `ErrorCode`, never its message text, which may echo addresses. */
async function errorCode(response: Response) {
  try {
    const code = ((await response.json()) as { ErrorCode?: unknown })
      ?.ErrorCode;
    return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Production transport; tests inject EmailDev instead. Every message is sent
 * from this adapter's `from` argument, which wins over `message.from`
 * (including `emailFrom` and a `renderEmail` sender), so one verified sender
 * signature covers the deployment. A failure throws an error carrying only
 * `httpStatus` and Postmark's numeric `ErrorCode` as `providerCode`, never
 * message content or Postmark's error text.
 */
export function postmarkEmail(token: string, from: string): EmailSender {
  if (!token || !from)
    throw new Error('Configure Postmark and the sender address');
  return {
    async send(message) {
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          'x-postmark-server-token': token,
        },
        body: JSON.stringify({
          From: from,
          To: message.to.join(','),
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html,
          MessageStream: 'outbound',
          ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
          ...(message.cc ? { Cc: message.cc.join(',') } : {}),
          ...(message.bcc ? { Bcc: message.bcc.join(',') } : {}),
          ...(message.headers
            ? {
                Headers: Object.entries(message.headers).map(
                  ([Name, Value]) => ({ Name, Value }),
                ),
              }
            : {}),
        }),
      });
      const code = await errorCode(response);
      if (!response.ok || code !== 0)
        throw new EmailDeliveryError(response.status, code);
    },
  };
}

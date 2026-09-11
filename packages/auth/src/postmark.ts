import type { EmailSender } from 'pgstencil';

class EmailDeliveryError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly providerCode?: number,
  ) {
    super('Email delivery failed');
  }
}

/** Production transport; tests inject EmailDev instead. Provider errors contain no message content. */
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
      if (!response.ok) throw new EmailDeliveryError(response.status);
      const result = (await response.json()) as { ErrorCode?: number };
      if (result.ErrorCode !== 0)
        throw new EmailDeliveryError(
          response.status,
          typeof result.ErrorCode === 'number' ? result.ErrorCode : undefined,
        );
    },
  };
}

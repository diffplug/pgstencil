import type { Time } from './time.ts';
export interface EmailMessage {
  to: string[];
  from: string;
  subject: string;
  html: string;
  text: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  headers?: Record<string, string>;
}
export interface CapturedEmail extends EmailMessage {
  capturedAt: string;
}
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
export class EmailDev implements EmailSender {
  private messages: CapturedEmail[] = [];
  private cursor = 0;
  private listeners = new Set<() => void>();
  private closed = false;
  private waiting = false;
  constructor(private readonly time: Time) {}
  async send(message: EmailMessage): Promise<void> {
    if (this.closed) throw new Error('EmailDev is closed');
    this.messages.push(
      structuredClone({
        ...message,
        capturedAt: this.time.now().toISOString(),
      }),
    );
    for (const listener of this.listeners) listener();
  }
  all(): CapturedEmail[] {
    return structuredClone(this.messages);
  }
  unreadCount(): number {
    return this.messages.length - this.cursor;
  }
  assertNoUnread(): void {
    if (this.unreadCount())
      throw new Error(`Expected no unread email; found ${this.unreadCount()}`);
  }
  async waitFor(count = 1, timeoutMs = 5000): Promise<CapturedEmail[]> {
    if (!Number.isInteger(count) || count < 1)
      throw new Error('Count must be positive');
    if (this.waiting)
      throw new Error('Only one email consumer may wait at a time');
    if (this.closed) throw new Error('EmailDev is closed');
    this.waiting = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          this.listeners.delete(check);
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (this.closed) finish(new Error('EmailDev closed while waiting'));
          else if (this.unreadCount() >= count) finish();
        };
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                `Wanted ${count} unread emails; found ${this.unreadCount()} after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
        this.listeners.add(check);
        check();
      });
      const result = this.messages.slice(this.cursor, this.cursor + count);
      this.cursor += count;
      return structuredClone(result);
    } finally {
      this.waiting = false;
    }
  }
  async next(timeoutMs = 5000): Promise<CapturedEmail> {
    return (await this.waitFor(1, timeoutMs))[0]!;
  }
  close(): void {
    this.closed = true;
    for (const listener of this.listeners) listener();
  }
}

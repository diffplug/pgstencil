import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function keyed(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret)
    .update(purpose)
    .update('\0')
    .update(value)
    .digest('hex');
}
export function equalDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return (
    left.length === 32 && right.length === 32 && timingSafeEqual(left, right)
  );
}
export function cookieValues(
  header: string | undefined,
): Record<string, string> {
  const values = Object.create(null) as Record<string, string>;
  for (const part of (header ?? '').split(';')) {
    const position = part.indexOf('=');
    if (position > 0)
      values[part.slice(0, position).trim()] = part.slice(position + 1).trim();
  }
  return values;
}
export function sessionCookie(
  name: string,
  value: string,
  now: Date,
  lifetimeSeconds: number,
  secure: boolean,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${lifetimeSeconds}; Expires=${new Date(lifetimeSeconds === 0 ? 0 : now.getTime() + lifetimeSeconds * 1000).toUTCString()}${secure ? '; Secure' : ''}`;
}
export function normalizeEmail(input: string): string | undefined {
  const email = input.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ? email
    : undefined;
}

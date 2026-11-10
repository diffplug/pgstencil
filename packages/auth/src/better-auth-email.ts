import { createHash } from 'node:crypto';

const identityDomain = 'identity.pgstencil.invalid';

export function isIdentityEmail(email: string) {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  // Reserve the whole DNS namespace, including an optional trailing root dot.
  const domain = email
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  return domain === identityDomain || domain.endsWith('.' + identityDomain);
}

/**
 * The sign-in email's sender: a non-blank `emailFrom`, trimmed, or
 * `signin@<hostname of origin>`. An IP origin gets an RFC 5321 address
 * literal (`signin@[127.0.0.1]`, `signin@[IPv6:::1]`), since a bare IP is not
 * a valid domain. `origin` is already canonical, so the URL parser has
 * normalized an IPv4 host to dotted decimal and bracketed an IPv6 one.
 */
export function signInSender(emailFrom: unknown, origin: string): string {
  const configured = typeof emailFrom === 'string' ? emailFrom.trim() : '';
  if (configured) return configured;
  const host = new URL(origin).hostname;
  if (host.startsWith('[')) return `signin@[IPv6:${host.slice(1, -1)}]`;
  if (/^[\d.]+$/.test(host)) return `signin@[${host}]`;
  return `signin@${host}`;
}

/** Better Auth requires an email column, even for a provider-only account.
 * This reserved address identifies an account; it is never a delivery address.
 * Include the client ID because provider subjects can be scoped to an app.
 */
export function identityEmail(
  provider: string,
  clientId: string,
  subject: unknown,
) {
  if (typeof subject !== 'string' && typeof subject !== 'number')
    throw new Error('Missing provider identity');
  if (!String(subject)) throw new Error('Missing provider identity');
  return (
    createHash('sha256')
      .update(JSON.stringify([provider, clientId, String(subject)]))
      .digest('hex') +
    '@' +
    identityDomain
  );
}

/** Microsoft object IDs are tenant-scoped. Never substitute mutable email/UPN. */
export function providerSubject(
  provider: string,
  profile: Record<string, unknown> | undefined,
) {
  if (provider !== 'microsoft') return profile?.sub ?? profile?.id;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof profile?.tid !== 'string' ||
    !uuid.test(profile.tid) ||
    typeof profile.oid !== 'string' ||
    !uuid.test(profile.oid)
  )
    throw new Error('Invalid Microsoft identity');
  return `${profile.tid.toLowerCase()}:${profile.oid.toLowerCase()}`;
}

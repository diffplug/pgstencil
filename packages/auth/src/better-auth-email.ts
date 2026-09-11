import { createHash } from 'node:crypto';

const identityDomain = '@identity.pgstencil.invalid';

export function isIdentityEmail(email: string) {
  return email.toLowerCase().endsWith(identityDomain);
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
      .digest('hex') + identityDomain
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

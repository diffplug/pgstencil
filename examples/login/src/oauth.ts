import { sql } from 'kysely';
import { token } from 'pgstencil';
import { Auth, type AuthResult, type AuthFailure } from './auth.ts';
import { digest, keyed } from './security.ts';
import {
  OAuthProviders,
  PROVIDER_LABELS,
  IdentityError,
  type Provider,
  type OAuthProof,
} from './oauth-providers.ts';

export const OAUTH_MS = 10 * 60_000;
export const CONNECT_FRESH_MS = 5 * 60_000;
type Session = NonNullable<Awaited<ReturnType<Auth['session']>>>;
const failure = (message: string, status = 400): AuthFailure => ({
  ok: false,
  status,
  message,
});
const unavailable = () =>
  failure('This sign-in attempt is invalid or has expired. Start again.');

export class OAuth {
  constructor(
    readonly auth: Auth,
    readonly providers: OAuthProviders,
  ) {}
  private proof(state: string, redirectUri: string): OAuthProof {
    // Derivation keeps verifiers/nonces out of storage and works across server
    // instances sharing the application secret. Each state is fresh randomness.
    return {
      state,
      redirectUri,
      verifier: keyed(this.auth.deps.secret, 'oauth-pkce', state),
      nonce: keyed(this.auth.deps.secret, 'oauth-nonce', state),
    };
  }
  private fresh(session: Session): boolean {
    const now = this.auth.deps.time.now();
    const age = now.getTime() - session.created_at.getTime();
    return (
      !session.revoked_at &&
      session.expires_at > now &&
      age >= 0 &&
      age < CONNECT_FRESH_MS
    );
  }
  async begin(
    provider: Provider,
    source: string,
    linking?: Session,
  ): Promise<
    AuthFailure | { ok: true; url: string; cookie: string; seconds: number }
  > {
    if (linking && !this.fresh(linking))
      return failure(
        'Sign in again before connecting another sign-in method.',
        403,
      );
    if (!(await this.auth.allowOAuthStart(source)))
      return failure('Too many sign-in attempts. Please try again later.', 429);
    const { random, time, db, origin } = this.auth.deps;
    const state = token(random);
    const browser = token(random);
    const redirectUri = `${origin}/oauth/${provider}/callback`;
    const url = await this.providers.authorizationUrl(
      provider,
      this.proof(state, redirectUri),
      linking !== undefined,
    );
    const now = time.now();
    const expires = new Date(
      Math.min(
        now.getTime() + OAUTH_MS,
        linking ? linking.created_at.getTime() + CONNECT_FRESH_MS : Infinity,
      ),
    );
    await db
      .insertInto('oauth_flows')
      .values({
        state_hash: digest(state),
        provider,
        browser_hash: digest(browser),
        redirect_uri: redirectUri,
        link_user_id: linking?.user_id ?? null,
        link_session_hash: linking?.token_hash ?? null,
        created_at: now,
        expires_at: expires,
        consumed_at: null,
      })
      .execute();
    return {
      ok: true,
      url: url.href,
      cookie: browser,
      seconds: Math.max(
        0,
        Math.floor((expires.getTime() - now.getTime()) / 1000),
      ),
    };
  }
  async complete(
    provider: Provider,
    callback: URL,
    browser: string | undefined,
    rawSession: string | undefined,
  ): Promise<{ result: AuthResult; clearCookie: boolean }> {
    const state = callback.searchParams.get('state');
    if (
      !state ||
      callback.searchParams.getAll('state').length !== 1 ||
      !/^[\w-]{43}$/.test(state) ||
      !browser ||
      !/^[\w-]{43}$/.test(browser)
    )
      return { result: unavailable(), clearCookie: false };
    const { db, time, random } = this.auth.deps;
    // Claim once before network I/O. Concurrent callbacks cannot both exchange
    // the code, and failures/cancellation cannot be replayed into a session.
    const flow = await db
      .updateTable('oauth_flows')
      .set({ consumed_at: time.now() })
      .where('state_hash', '=', digest(state))
      .where('provider', '=', provider)
      .where('browser_hash', '=', digest(browser))
      .where('redirect_uri', '=', callback.origin + callback.pathname)
      .where('expires_at', '>', time.now())
      .where('consumed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!flow) return { result: unavailable(), clearCookie: false };
    const done = (result: AuthResult) => ({ result, clearCookie: true });
    if (callback.searchParams.has('error'))
      return done(failure('Sign-in was not completed. You can try again.'));
    if (
      flow.link_session_hash &&
      (!rawSession || digest(rawSession) !== flow.link_session_hash)
    )
      return done(
        failure('Sign in again before connecting another sign-in method.', 403),
      );
    try {
      const identity = await this.providers.identity(
        provider,
        callback,
        this.proof(state, flow.redirect_uri),
      );
      const result = await db
        .transaction()
        .execute(async (trx): Promise<AuthResult> => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${'oauth-identity:' + provider + ':' + identity.subject}))`.execute(
            trx,
          );
          const now = time.now();
          if (flow.expires_at <= now) return unavailable();
          const existing = await trx
            .selectFrom('oauth_identities')
            .select('user_id')
            .where('provider', '=', provider)
            .where('subject', '=', identity.subject)
            .executeTakeFirst();
          let userId: string;
          if (flow.link_user_id && flow.link_session_hash) {
            const session = await trx
              .selectFrom('sessions')
              .innerJoin('users', 'users.id', 'sessions.user_id')
              .selectAll('sessions')
              .select('users.email')
              .where('token_hash', '=', flow.link_session_hash)
              .forUpdate('sessions')
              .executeTakeFirst();
            if (
              !session ||
              session.user_id !== flow.link_user_id ||
              !this.fresh(session)
            )
              return failure(
                'Sign in again before connecting another sign-in method.',
                403,
              );
            if (session.email !== identity.email)
              return failure(
                'The provider must verify the same email address as your account.',
                403,
              );
            if (existing && existing.user_id !== session.user_id)
              return failure(
                'This provider account is already connected to another account.',
                409,
              );
            userId = session.user_id;
            if (!existing) {
              const connected = await trx
                .insertInto('oauth_identities')
                .values({
                  provider,
                  subject: identity.subject,
                  user_id: userId,
                  created_at: now,
                })
                .onConflict((c) => c.doNothing())
                .returning('user_id')
                .executeTakeFirst();
              if (!connected)
                return failure(
                  'A different account from this provider is already connected.',
                  409,
                );
            }
          } else if (existing) {
            // A changed email/handle must never change which account a stable
            // provider identity signs into, or silently update its recovery email.
            userId = existing.user_id;
          } else {
            const user = await trx
              .insertInto('users')
              .values({
                id: token(random, 16),
                email: identity.email,
                created_at: now,
              })
              .onConflict((c) => c.column('email').doNothing())
              .returning('id')
              .executeTakeFirst();
            if (!user)
              return failure(
                'This email already has an account. Sign in with email or an existing method, then connect this provider from your account.',
                409,
              );
            userId = user.id;
            await trx
              .insertInto('oauth_identities')
              .values({
                provider,
                subject: identity.subject,
                user_id: userId,
                created_at: now,
              })
              .execute();
          }
          return {
            ok: true,
            session: await this.auth.issueSession(trx, userId, rawSession, now),
          };
        });
      return done(result);
    } catch (error) {
      return done(
        failure(
          error instanceof IdentityError
            ? error.message
            : `Could not complete sign-in with ${PROVIDER_LABELS[provider]}. Please try again.`,
          error instanceof IdentityError ? 403 : 502,
        ),
      );
    }
  }
}

import { sql, type Kysely, type Transaction, type Selectable } from 'kysely';
import {
  token,
  decimalCode,
  type RandomSource,
  type Time,
  type EmailSender,
} from 'pgstencil';
import type { DB, LoginFlows, Sessions } from './db.generated.ts';
import { digest, keyed, equalDigest } from './security.ts';
import { loginEmail } from './email.ts';
export const CHALLENGE_MS = 10 * 60_000;
export const SESSION_MS = 24 * 3_600_000;
export interface AuthDependencies {
  db: Kysely<DB>;
  time: Time;
  random: RandomSource;
  email: EmailSender;
  secret: string;
  origin: string;
  renderEmail?: typeof loginEmail;
}
export type SessionRow = Selectable<Sessions> & { email: string };
export interface Pending {
  flow: Selectable<LoginFlows>;
  csrf: string;
  cookie: string;
}
export interface AuthFailure {
  ok: false;
  status: number;
  message: string;
}
export type AuthResult = { ok: true; session: string } | AuthFailure;
export class Auth {
  constructor(readonly deps: AuthDependencies) {
    if (deps.secret.length < 32)
      throw new Error('Auth secret must contain at least 32 characters');
  }
  /** Secret-derived, purpose-separated value. Keeps the raw secret in Auth. */
  derive(purpose: string, value: string): string {
    return keyed(this.deps.secret, purpose, value);
  }
  sessionCsrf(raw: string): string {
    return this.derive('session-csrf', raw);
  }
  async newFlow(): Promise<Pending> {
    const { db, random, time } = this.deps;
    const id = token(random, 16);
    const binding = token(random);
    const csrf = this.derive('flow-csrf', binding);
    const now = time.now();
    const flow = await db
      .insertInto('login_flows')
      .values({
        id,
        binding_hash: digest(binding),
        csrf_hash: digest(csrf),
        email: null,
        created_at: now,
        expires_at: new Date(now.getTime() + 30 * 60_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { flow, csrf, cookie: `${id}.${binding}` };
  }
  async pending(cookie: string | undefined): Promise<Pending | undefined> {
    if (!cookie) return;
    const parts = cookie.split('.');
    if (parts.length !== 2) return;
    const [id, binding] = parts as [string, string];
    const flow = await this.deps.db
      .selectFrom('login_flows')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (
      !flow ||
      flow.expires_at <= this.deps.time.now() ||
      !equalDigest(flow.binding_hash, digest(binding))
    )
      return;
    return { flow, csrf: this.derive('flow-csrf', binding), cookie };
  }
  validCsrf(pending: Pending, csrf: string): boolean {
    return equalDigest(pending.flow.csrf_hash, digest(csrf));
  }
  /** The session-scoped counterpart of validCsrf, for signed-in form posts. */
  validSessionCsrf(
    session: SessionRow | undefined,
    csrf: string,
  ): session is SessionRow {
    return !!session && equalDigest(session.csrf_hash, digest(csrf));
  }
  private async rate(
    trx: Transaction<DB>,
    keys: { key: string; limit: number }[],
  ): Promise<boolean> {
    const now = this.deps.time.now();
    let allowed = true;
    for (const { key, limit } of [...keys].sort((a, b) =>
      a.key.localeCompare(b.key),
    )) {
      // Inserting first also serializes the very first use of a key. Unlike
      // advisory locks, row locks work through Hyperdrive transaction pooling.
      await trx
        .insertInto('rate_limits')
        .values({ key, count: 0, window_start: now })
        .onConflict((c) => c.column('key').doNothing())
        .execute();
      const previous = await trx
        .selectFrom('rate_limits')
        .selectAll()
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      const fresh =
        !previous ||
        now.getTime() - previous.window_start.getTime() >= 15 * 60_000;
      const count = fresh ? 1 : Math.min(previous.count + 1, limit + 1);
      allowed &&= count <= limit;
      await trx
        .insertInto('rate_limits')
        .values({
          key,
          count,
          window_start: fresh ? now : previous.window_start,
        })
        .onConflict((c) =>
          c.column('key').doUpdateSet({
            count,
            window_start: fresh ? now : previous.window_start,
          }),
        )
        .execute();
    }
    return allowed;
  }
  async send(
    pending: Pending,
    email: string,
    source: string,
  ): Promise<{ ok: true } | AuthFailure> {
    const { db, time, random } = this.deps;
    const now = time.now();
    // One value for both the stored challenge and the email that announces it.
    const expiresAt = new Date(
      Math.min(now.getTime() + CHALLENGE_MS, pending.flow.expires_at.getTime()),
    );
    const prepared = await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('login_flows')
        .select('id')
        .where('id', '=', pending.flow.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const recent = await trx
        .selectFrom('login_challenges')
        .select('created_at')
        .where('flow_id', '=', pending.flow.id)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (recent && now.getTime() - recent.created_at.getTime() < 60_000)
        return;
      if (
        !(await this.rate(trx, [
          { key: `send:email:${email}`, limit: 5 },
          { key: `send:ip:${source}`, limit: 30 },
        ]))
      )
        return;
      await trx
        .updateTable('login_challenges')
        .set({ invalidated_at: now })
        .where('flow_id', '=', pending.flow.id)
        .where('consumed_at', 'is', null)
        .where('invalidated_at', 'is', null)
        .execute();
      await trx
        .updateTable('login_flows')
        .set({ email })
        .where('id', '=', pending.flow.id)
        .execute();
      const id = token(random, 16);
      const code = decimalCode(random);
      const link = token(random);
      await trx
        .insertInto('login_challenges')
        .values({
          id,
          flow_id: pending.flow.id,
          email,
          code_digest: keyed(this.deps.secret, 'login-code', `${id}:${code}`),
          link_hash: digest(link),
          created_at: now,
          expires_at: expiresAt,
          consumed_at: null,
          invalidated_at: null,
          delivered_at: null,
        })
        .execute();
      return { id, code, link };
    });
    if (!prepared)
      return {
        ok: false,
        status: 429,
        message: 'Please wait before requesting another code.',
      };
    const link = `${this.deps.origin}/login/link?id=${prepared.id}&token=${prepared.link}`;
    try {
      await this.deps.email.send(
        (this.deps.renderEmail ?? loginEmail)(
          email,
          prepared.code,
          link,
          expiresAt,
        ),
      );
      await db
        .updateTable('login_challenges')
        .set({ delivered_at: time.now() })
        .where('id', '=', prepared.id)
        .execute();
      return { ok: true };
    } catch {
      await db
        .updateTable('login_challenges')
        .set({ invalidated_at: time.now() })
        .where('id', '=', prepared.id)
        .execute();
      return {
        ok: false,
        status: 503,
        message: 'We could not send your email. Please try again in a minute.',
      };
    }
  }
  async verify(
    pending: Pending,
    method: 'code' | 'link',
    value: string,
    challengeId: string | undefined,
    source: string,
    priorSession?: string,
  ): Promise<AuthResult> {
    const { db, time, random } = this.deps;
    const now = time.now();
    return db.transaction().execute(async (trx) => {
      // Same lock as resend: replacing and redeeming a challenge cannot race.
      await trx
        .selectFrom('login_flows')
        .select('id')
        .where('id', '=', pending.flow.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const invalid: AuthResult = {
        ok: false,
        status: 400,
        message:
          'That code or link is invalid or has expired. Request a new code to try again.',
      };
      const challenge = await trx
        .selectFrom('login_challenges')
        .selectAll()
        .where('flow_id', '=', pending.flow.id)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      if (
        !challenge ||
        !challenge.delivered_at ||
        challenge.consumed_at ||
        challenge.invalidated_at ||
        challenge.expires_at <= now ||
        pending.flow.expires_at <= now ||
        challenge.attempts >= 5
      )
        return invalid;
      if (
        !(await this.rate(trx, [
          { key: `verify:email:${challenge.email}`, limit: 15 },
          { key: `verify:ip:${source}`, limit: 100 },
        ]))
      )
        return {
          ok: false,
          status: 429,
          message: 'Too many attempts. Please try again later.',
        };
      const code = value.replace(/\s/g, '');
      const matched =
        method === 'code'
          ? /^\d{8}$/.test(code) &&
            equalDigest(
              challenge.code_digest,
              keyed(this.deps.secret, 'login-code', `${challenge.id}:${code}`),
            )
          : challenge.id === challengeId &&
            equalDigest(challenge.link_hash, digest(value));
      if (!matched) {
        const attempts = challenge.attempts + 1;
        await trx
          .updateTable('login_challenges')
          .set({ attempts, ...(attempts >= 5 ? { invalidated_at: now } : {}) })
          .where('id', '=', challenge.id)
          .execute();
        return invalid;
      }
      await trx
        .updateTable('login_challenges')
        .set({ consumed_at: now })
        .where('id', '=', challenge.id)
        .execute();
      // DO UPDATE (unlike DO NOTHING) returns the existing row, so the id
      // comes back without a second round trip.
      const user = await trx
        .insertInto('users')
        .values({
          id: token(random, 16),
          email: challenge.email,
          created_at: now,
        })
        .onConflict((c) =>
          c.column('email').doUpdateSet({ email: sql`excluded.email` }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      const session = await this.issueSession(trx, user.id, priorSession, now);
      await trx
        .updateTable('login_flows')
        .set({ expires_at: now })
        .where('id', '=', pending.flow.id)
        .execute();
      return { ok: true, session };
    });
  }
  /** Shared session issuance after an email or OAuth proof has been verified. */
  async issueSession(
    trx: Transaction<DB>,
    userId: string,
    priorSession: string | undefined,
    now = this.deps.time.now(),
  ): Promise<string> {
    if (priorSession)
      await trx
        .updateTable('sessions')
        .set({ revoked_at: now })
        .where('token_hash', '=', digest(priorSession))
        .execute();
    const session = token(this.deps.random);
    await trx
      .insertInto('sessions')
      .values({
        token_hash: digest(session),
        user_id: userId,
        csrf_hash: digest(this.sessionCsrf(session)),
        created_at: now,
        expires_at: new Date(now.getTime() + SESSION_MS),
        revoked_at: null,
      })
      .execute();
    return session;
  }
  async allowOAuthStart(source: string): Promise<boolean> {
    return this.deps.db
      .transaction()
      .execute((trx) =>
        this.rate(trx, [{ key: `oauth:ip:${source}`, limit: 30 }]),
      );
  }
  private sessionQuery(
    executor: Kysely<DB> | Transaction<DB>,
    tokenHash: string,
  ) {
    return executor
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .selectAll('sessions')
      .select('users.email')
      .where('token_hash', '=', tokenHash);
  }
  /** True while a session may still authenticate a request. */
  live(session: Selectable<Sessions>): boolean {
    return !session.revoked_at && session.expires_at > this.deps.time.now();
  }
  async session(raw: string | undefined): Promise<SessionRow | undefined> {
    if (!raw) return;
    return this.sessionQuery(this.deps.db, digest(raw))
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', this.deps.time.now())
      .executeTakeFirst();
  }
  /** Row-locked read for callers that must decide and write in one transaction. */
  async lockedSession(
    trx: Transaction<DB>,
    tokenHash: string,
  ): Promise<SessionRow | undefined> {
    return this.sessionQuery(trx, tokenHash)
      .forUpdate('sessions')
      .executeTakeFirst();
  }
  async logout(raw: string): Promise<void> {
    await this.deps.db
      .updateTable('sessions')
      .set({ revoked_at: this.deps.time.now() })
      .where('token_hash', '=', digest(raw))
      .execute();
  }
}

import Stripe from 'stripe';
import { sql, type Kysely, type Transaction } from 'kysely';
import { token, type Time, type RandomSource } from 'pgstencil';
import type { BillingDB } from './db.ts';
export type { BillingDB } from './db.ts';
export { Stripe };
export const STRIPE_API_VERSION = Stripe.API_VERSION;
export type Plan = 'monthly' | 'yearly';
export interface BillingConfig {
  prices: Record<Plan, string>;
  trialDays: number;
  webhookSecret: string;
  live: boolean;
  origin: string;
  returnPath?: string;
  portalConfiguration?: string;
  /** Origins this billing setup redirects the browser to; defaults to Stripe's. */
  redirectOrigins?: readonly string[];
}
export class BillingError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const OPEN = ['pending', 'open'];
const SUBSCRIBED = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
];
const idOf = (value: string | { id: string } | null): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null);
const instant = (seconds: number) => new Date(seconds * 1000);
/** Stripe idempotency keys expire after 24h; refuse to reuse one near that edge. */
const RETRY_WINDOW_MS = 23 * 3600000;
const STRIPE_REDIRECT_ORIGINS = [
  'https://checkout.stripe.com',
  'https://billing.stripe.com',
];

/** Owns billing state; HTTP adapters supply an already-authorized owner ID. */
export class Billing {
  readonly db: Kysely<BillingDB>;
  readonly returnUrl: string;
  /** Hosts a caller must allow in its CSP form-action for Checkout to work. */
  readonly redirectOrigins: readonly string[];
  private readonly plans: ReadonlyMap<string, Plan>;
  constructor(
    db: Kysely<BillingDB>,
    readonly stripe: Stripe,
    readonly time: Time,
    readonly random: RandomSource,
    readonly config: BillingConfig,
  ) {
    this.db = db.withSchema('pgstencil_billing');
    if (
      !Number.isInteger(config.trialDays) ||
      config.trialDays < 0 ||
      config.trialDays > 730
    )
      throw new Error('trialDays must be an integer between 0 and 730');
    if (
      !config.prices.monthly ||
      !config.prices.yearly ||
      config.prices.monthly === config.prices.yearly
    )
      throw new Error('Configure distinct monthly and yearly Stripe prices');
    if (!config.webhookSecret)
      throw new Error('A Stripe webhook secret is required');
    if (new URL(config.origin).origin !== config.origin)
      throw new Error('Billing origin must be an origin only');
    this.returnUrl = new URL(
      config.returnPath ?? '/billing',
      config.origin,
    ).href;
    if (new URL(this.returnUrl).origin !== config.origin)
      throw new Error('Billing return URL must be same-origin');
    this.redirectOrigins = config.redirectOrigins ?? STRIPE_REDIRECT_ORIGINS;
    for (const value of this.redirectOrigins)
      if (new URL(value).origin !== value)
        throw new Error('Billing redirect origins must be origins only');
    this.plans = new Map(
      (Object.entries(config.prices) as [Plan, string][]).map(([plan, id]) => [
        id,
        plan,
      ]),
    );
  }
  /** A retired price no longer maps to a plan, so report it as unknown. */
  private planOf(priceId: string | null | undefined): Plan | null {
    return (priceId && this.plans.get(priceId)) || null;
  }
  private assertRetryable(startedAt: Date, what: string): void {
    if (this.time.now().getTime() - startedAt.getTime() >= RETRY_WINDOW_MS)
      throw new BillingError(
        `${what} creation needs reconciliation before retrying.`,
      );
  }
  /** Ensures the owner has a billing account row. Safe to call on every view. */
  async account(ownerId: string, email: string): Promise<void> {
    if (!ownerId || !email)
      throw new Error('Billing requires an owner and email');
    await this.db
      .insertInto('accounts')
      .values({
        owner_id: ownerId,
        email,
        created_at: this.time.now(),
        trial_used_at: null,
        customer_id: null,
        customer_key: null,
        customer_started_at: null,
      })
      .onConflict((c) => c.column('owner_id').doNothing())
      .execute();
  }
  private async customer(ownerId: string, email: string): Promise<string> {
    await this.account(ownerId, email);
    const account = await this.db.transaction().execute(async (trx) => {
      let row = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!row.customer_id && !row.customer_key)
        row = await trx
          .updateTable('accounts')
          .set({
            customer_key: token(this.random),
            customer_started_at: this.time.now(),
          })
          .where('owner_id', '=', ownerId)
          .returningAll()
          .executeTakeFirstOrThrow();
      return row;
    });
    if (account.customer_id) return account.customer_id;
    this.assertRetryable(account.customer_started_at!, 'Customer');
    const customer = await this.stripe.customers.create(
      { email: account.email, metadata: { pgstencil_owner: ownerId } },
      { idempotencyKey: account.customer_key! },
    );
    await this.db
      .updateTable('accounts')
      .set({ customer_id: customer.id })
      .where('owner_id', '=', ownerId)
      .execute();
    return customer.id;
  }
  async checkout(
    ownerId: string,
    email: string,
    plan: Plan,
  ): Promise<{ id: string; url: string }> {
    if (plan !== 'monthly' && plan !== 'yearly')
      throw new BillingError('Choose monthly or yearly.', 400);
    const customer = await this.customer(ownerId, email);
    await this.reconcile(ownerId);
    let operation = await this.db.transaction().execute(async (trx) => {
      const account = await trx
        .selectFrom('accounts')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const subscription = await trx
        .selectFrom('subscriptions')
        .select('id')
        .where('owner_id', '=', ownerId)
        .where('status', 'in', SUBSCRIBED)
        .executeTakeFirst();
      if (subscription)
        throw new BillingError(
          'Use Manage billing for your existing subscription.',
        );
      const existing = await trx
        .selectFrom('checkouts')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('status', 'in', OPEN)
        .executeTakeFirst();
      if (existing) {
        if (existing.plan !== plan)
          throw new BillingError(
            'Cancel the open checkout before choosing another plan.',
          );
        return existing;
      }
      return trx
        .insertInto('checkouts')
        .values({
          id: token(this.random),
          owner_id: ownerId,
          plan,
          price_id: this.config.prices[plan],
          trial_days: account.trial_used_at ? 0 : this.config.trialDays,
          status: 'pending',
          session_id: null,
          url: null,
          created_at: this.time.now(),
          expires_at: new Date(this.time.now().getTime() + 60 * 60000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    let created: Stripe.Checkout.Session | undefined;
    if (!operation.session_id) {
      // Save the operation before network I/O. Its retry key and parameters never change.
      this.assertRetryable(operation.created_at, 'Checkout');
      const success = new URL(this.returnUrl);
      success.searchParams.set('checkout', operation.id);
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer,
          client_reference_id: ownerId,
          line_items: [{ price: operation.price_id, quantity: 1 }],
          payment_method_collection: 'always',
          payment_method_types: ['card'],
          subscription_data: {
            metadata: {
              pgstencil_owner: ownerId,
              pgstencil_operation: operation.id,
            },
            ...(operation.trial_days
              ? {
                  trial_period_days: operation.trial_days,
                  trial_settings: {
                    end_behavior: { missing_payment_method: 'cancel' },
                  },
                }
              : {}),
          },
          metadata: { pgstencil_operation: operation.id },
          success_url: success.href,
          cancel_url: this.returnUrl,
          expires_at: Math.floor(operation.expires_at.getTime() / 1000),
        },
        { idempotencyKey: operation.id },
      );
      if (!session.url) throw new Error('Stripe did not return a checkout URL');
      created = session;
      operation = await this.db
        .updateTable('checkouts')
        .set({ session_id: session.id, url: session.url, status: 'open' })
        .where('id', '=', operation.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    // A session we just created needs no round trip to read back.
    const session =
      created ??
      (await this.stripe.checkout.sessions.retrieve(operation.session_id!));
    if (session.status === 'expired') {
      await this.db
        .updateTable('checkouts')
        .set({ status: 'expired' })
        .where('id', '=', operation.id)
        .execute();
      throw new BillingError('Checkout expired. Start again.');
    }
    if (session.status === 'complete') {
      await this.confirmCheckout(ownerId, operation.id, session);
      throw new BillingError('Checkout is complete. Refresh billing.');
    }
    return { id: operation.id, url: session.url ?? operation.url! };
  }
  async cancelCheckout(ownerId: string): Promise<void> {
    const operation = await this.db
      .selectFrom('checkouts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('status', 'in', OPEN)
      .executeTakeFirst();
    if (!operation) return;
    if (!operation.session_id)
      throw new BillingError('Checkout is still being created. Retry shortly.');
    const session = await this.stripe.checkout.sessions.retrieve(
      operation.session_id,
    );
    if (session.status === 'complete') {
      await this.confirmCheckout(ownerId, operation.id, session);
      return;
    }
    if (session.status === 'open')
      await this.stripe.checkout.sessions.expire(session.id);
    await this.db
      .updateTable('checkouts')
      .set({ status: 'expired' })
      .where('id', '=', operation.id)
      .execute();
  }
  async confirmCheckout(
    ownerId: string,
    operationId: string,
    known?: Stripe.Checkout.Session,
  ): Promise<void> {
    const operation = await this.db
      .selectFrom('checkouts')
      .selectAll()
      .where('id', '=', operationId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!operation?.session_id)
      throw new BillingError('Checkout not found.', 404);
    const account = await this.db
      .selectFrom('accounts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    const session =
      known ??
      (await this.stripe.checkout.sessions.retrieve(operation.session_id));
    if (
      session.client_reference_id !== ownerId ||
      idOf(session.customer) !== account.customer_id ||
      session.mode !== 'subscription'
    )
      throw new Error('Checkout owner mismatch');
    if (session.status === 'complete') {
      await this.reconcile(ownerId);
      await this.db
        .updateTable('checkouts')
        .set({ status: 'complete' })
        .where('id', '=', operation.id)
        .execute();
    }
  }
  async portal(ownerId: string): Promise<string> {
    const account = await this.db
      .selectFrom('accounts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (!account?.customer_id)
      throw new BillingError('Start a subscription first.');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: account.customer_id,
      return_url: this.returnUrl,
      ...(this.config.portalConfiguration
        ? { configuration: this.config.portalConfiguration }
        : {}),
    });
    return session.url;
  }
  private async synchronize(
    trx: Transaction<BillingDB>,
    ownerId: string,
  ): Promise<void> {
    const account = await trx
      .selectFrom('accounts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!account.customer_id) return;
    // Fetch after the owner lock: competing webhook reads cannot overwrite newer state.
    const subscriptions = await this.stripe.subscriptions.list({
      customer: account.customer_id,
      status: 'all',
      limit: 100,
    });
    if (subscriptions.has_more)
      throw new Error('Subscription reconciliation requires pagination');
    const recognized = subscriptions.data.filter(
      (sub) => sub.metadata.pgstencil_owner === ownerId,
    );
    const now = this.time.now();
    const rows = recognized.map((sub) => {
      const item = sub.items.data[0];
      if (
        idOf(sub.customer) !== account.customer_id ||
        sub.items.data.length !== 1 ||
        !item ||
        !this.planOf(item.price.id) ||
        item.quantity !== 1 ||
        sub.livemode !== this.config.live
      )
        throw new Error('Subscription configuration mismatch');
      return {
        id: sub.id,
        owner_id: ownerId,
        price_id: item.price.id,
        status: sub.status,
        period_end: instant(item.current_period_end),
        trial_end: sub.trial_end === null ? null : instant(sub.trial_end),
        cancel_at_period_end: sub.cancel_at_period_end,
        updated_at: now,
      };
    });
    // A complete list is authoritative, including subscriptions that
    // disappeared, but rows we are about to rewrite need no interim update.
    let missing = trx
      .updateTable('subscriptions')
      .set({ status: 'missing' })
      .where('owner_id', '=', ownerId);
    if (rows.length)
      missing = missing.where(
        'id',
        'not in',
        rows.map((row) => row.id),
      );
    await missing.execute();
    if (rows.length)
      await trx
        .insertInto('subscriptions')
        .values(rows)
        .onConflict((c) =>
          c.column('id').doUpdateSet((eb) => ({
            owner_id: eb.ref('excluded.owner_id'),
            price_id: eb.ref('excluded.price_id'),
            status: eb.ref('excluded.status'),
            period_end: eb.ref('excluded.period_end'),
            trial_end: eb.ref('excluded.trial_end'),
            cancel_at_period_end: eb.ref('excluded.cancel_at_period_end'),
            updated_at: eb.ref('excluded.updated_at'),
          })),
        )
        .execute();
    const operations = recognized
      .map((sub) => sub.metadata.pgstencil_operation)
      .filter((id): id is string => !!id);
    if (operations.length)
      await trx
        .updateTable('checkouts')
        .set({ status: 'complete' })
        .where('owner_id', '=', ownerId)
        .where('id', 'in', operations)
        .where('status', 'in', OPEN)
        .execute();
    if (recognized.length) {
      await trx
        .updateTable('accounts')
        .set({ trial_used_at: account.trial_used_at ?? now })
        .where('owner_id', '=', ownerId)
        .execute();
    }
  }
  async reconcile(ownerId: string): Promise<void> {
    await this.db
      .transaction()
      .execute((trx) => this.synchronize(trx, ownerId));
  }
  async status(ownerId: string) {
    const account = await this.db
      .selectFrom('accounts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    const subscriptions = await this.db
      .selectFrom('subscriptions')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('updated_at', 'desc')
      .orderBy('id')
      .execute();
    const current = subscriptions.filter((sub) =>
      SUBSCRIBED.includes(sub.status),
    );
    const subscription = current[0] ?? subscriptions[0] ?? null;
    const until =
      subscription?.status === 'trialing'
        ? subscription.trial_end
        : subscription?.period_end;
    const access =
      current.length === 1 &&
      !!subscription &&
      ['trialing', 'active'].includes(subscription.status) &&
      !!until &&
      until > this.time.now();
    const trialEligible = !account?.trial_used_at;
    return {
      access,
      trialEligible,
      subscription,
      plan: this.planOf(subscription?.price_id),
      accessUntil: until ?? null,
      // What a checkout started now would grant, so callers render one value.
      trialDays: trialEligible ? this.config.trialDays : 0,
    };
  }
  /** Throws BillingError(400) for anything the sender got wrong. */
  async verifyWebhook(
    body: Buffer | string,
    signature: string,
  ): Promise<Stripe.Event> {
    let event: Stripe.Event;
    try {
      event = await this.stripe.webhooks.constructEventAsync(
        body,
        signature,
        this.config.webhookSecret,
        300,
        Stripe.createSubtleCryptoProvider(),
        this.time.now().getTime(),
      );
    } catch (error) {
      throw new BillingError(
        error instanceof Error ? error.message : 'Invalid Stripe signature.',
        400,
      );
    }
    if (
      event.livemode !== this.config.live ||
      event.api_version !== STRIPE_API_VERSION ||
      event.account
    )
      throw new BillingError('Unexpected Stripe event configuration.', 400);
    return event;
  }
  async webhook(
    body: Buffer | string,
    signature: string,
    /** Application database effects join the same commit and retry boundary. */
    apply?: (event: Stripe.Event, trx: Transaction<BillingDB>) => Promise<void>,
  ): Promise<void> {
    const event = await this.verifyWebhook(body, signature);
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('events')
          .values({
            id: event.id,
            type: event.type,
            received_at: this.time.now(),
            processed_at: null,
            attempts: 0,
            failed: false,
          })
          .onConflict((c) => c.column('id').doNothing())
          .execute();
        const saved = await trx
          .selectFrom('events')
          .selectAll()
          .where('id', '=', event.id)
          .forUpdate()
          .executeTakeFirst();
        if (saved?.processed_at) return;
        // Any event naming a customer we own triggers the same authoritative
        // resync, so no per-type allowlist can silently drop an update.
        const object = event.data.object as {
          customer?: string | { id: string } | null;
        };
        const customer = idOf(object.customer ?? null);
        if (customer) {
          const account = await trx
            .selectFrom('accounts')
            .select('owner_id')
            .where('customer_id', '=', customer)
            .executeTakeFirst();
          if (account) await this.synchronize(trx, account.owner_id);
        }
        if (apply) await apply(event, trx);
        const now = this.time.now();
        const processed = {
          processed_at: now,
          failed: false,
          attempts: (saved?.attempts ?? 0) + 1,
        };
        await trx
          .insertInto('events')
          .values({
            id: event.id,
            type: event.type,
            received_at: now,
            ...processed,
          })
          .onConflict((c) => c.column('id').doUpdateSet(processed))
          .execute();
      });
    } catch (error) {
      await this.db
        .insertInto('events')
        .values({
          id: event.id,
          type: event.type,
          received_at: this.time.now(),
          processed_at: null,
          attempts: 1,
          failed: true,
        })
        .onConflict((c) =>
          c
            .column('id')
            .doUpdateSet({ attempts: sql`events.attempts + 1`, failed: true })
            .where('events.processed_at', 'is', null),
        )
        .execute();
      throw error;
    }
  }
}

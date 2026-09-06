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

/** Owns billing state; HTTP adapters supply an already-authorized owner ID. */
export class Billing {
  readonly db: Kysely<BillingDB>;
  readonly returnUrl: string;
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
  }
  async account(ownerId: string, email: string) {
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
    return this.db
      .selectFrom('accounts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
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
    if (
      this.time.now().getTime() - account.customer_started_at!.getTime() >=
      23 * 3600000
    )
      throw new BillingError(
        'Customer creation needs reconciliation before retrying.',
      );
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
          expires_at: new Date(this.time.now().getTime() + 30 * 60000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    if (!operation.session_id) {
      // Save the operation before network I/O. Its retry key and parameters never change.
      if (
        this.time.now().getTime() - operation.created_at.getTime() >=
        23 * 3600000
      )
        throw new BillingError(
          'Checkout creation needs reconciliation before retrying.',
        );
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
      operation = await this.db
        .updateTable('checkouts')
        .set({ session_id: session.id, url: session.url, status: 'open' })
        .where('id', '=', operation.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    const session = await this.stripe.checkout.sessions.retrieve(
      operation.session_id!,
    );
    if (session.status === 'expired') {
      await this.db
        .updateTable('checkouts')
        .set({ status: 'expired' })
        .where('id', '=', operation.id)
        .execute();
      throw new BillingError('Checkout expired. Start again.');
    }
    if (session.status === 'complete') {
      await this.confirmCheckout(ownerId, operation.id);
      throw new BillingError('Checkout is complete. Refresh billing.');
    }
    return { id: operation.id, url: operation.url! };
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
      await this.confirmCheckout(ownerId, operation.id);
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
  async confirmCheckout(ownerId: string, operationId: string): Promise<void> {
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
    const session = await this.stripe.checkout.sessions.retrieve(
      operation.session_id,
    );
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
    // A complete list is authoritative, including subscriptions that disappeared.
    await trx
      .updateTable('subscriptions')
      .set({ status: 'missing' })
      .where('owner_id', '=', ownerId)
      .execute();
    for (const sub of recognized) {
      const item = sub.items.data[0];
      if (
        idOf(sub.customer) !== account.customer_id ||
        sub.items.data.length !== 1 ||
        !item ||
        !Object.values(this.config.prices).includes(item.price.id) ||
        item.quantity !== 1 ||
        sub.livemode !== this.config.live
      )
        throw new Error('Subscription configuration mismatch');
      const values = {
        owner_id: ownerId,
        price_id: item.price.id,
        status: sub.status,
        period_end: instant(item.current_period_end),
        trial_end: sub.trial_end === null ? null : instant(sub.trial_end),
        cancel_at_period_end: sub.cancel_at_period_end,
        updated_at: this.time.now(),
      };
      await trx
        .insertInto('subscriptions')
        .values({ id: sub.id, ...values })
        .onConflict((c) => c.column('id').doUpdateSet(values))
        .execute();
      if (sub.metadata.pgstencil_operation) {
        await trx
          .updateTable('checkouts')
          .set({ status: 'complete' })
          .where('owner_id', '=', ownerId)
          .where('id', '=', sub.metadata.pgstencil_operation)
          .where('status', 'in', OPEN)
          .execute();
      }
    }
    if (recognized.length) {
      await trx
        .updateTable('accounts')
        .set({ trial_used_at: account.trial_used_at ?? this.time.now() })
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
    return {
      access,
      trialEligible: !account?.trial_used_at,
      subscription,
      plan: subscription
        ? subscription.price_id === this.config.prices.monthly
          ? 'monthly'
          : 'yearly'
        : null,
      accessUntil: until ?? null,
    };
  }
  verifyWebhook(body: Buffer | string, signature: string): Stripe.Event {
    const event = this.stripe.webhooks.constructEvent(
      body,
      signature,
      this.config.webhookSecret,
      300,
      undefined,
      this.time.now().getTime(),
    );
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
    extra?: (event: Stripe.Event) => Promise<void>,
  ): Promise<void> {
    const event = this.verifyWebhook(body, signature);
    try {
      await this.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`stripe-event:${event.id}`}))`.execute(
          trx,
        );
        const saved = await trx
          .selectFrom('events')
          .selectAll()
          .where('id', '=', event.id)
          .executeTakeFirst();
        if (saved?.processed_at) return;
        const object = event.data.object as {
          customer?: string | { id: string } | null;
        };
        const customer = idOf(object.customer ?? null);
        if (
          customer &&
          (event.type.startsWith('customer.subscription.') ||
            event.type.startsWith('invoice.') ||
            event.type.startsWith('checkout.session.'))
        ) {
          const account = await trx
            .selectFrom('accounts')
            .select('owner_id')
            .where('customer_id', '=', customer)
            .executeTakeFirst();
          if (account) await this.synchronize(trx, account.owner_id);
        }
        if (extra) await extra(event);
        await trx
          .insertInto('events')
          .values({
            id: event.id,
            type: event.type,
            received_at: this.time.now(),
            processed_at: this.time.now(),
            attempts: (saved?.attempts ?? 0) + 1,
            failed: false,
          })
          .onConflict((c) =>
            c.column('id').doUpdateSet({
              processed_at: this.time.now(),
              failed: false,
              attempts: (saved?.attempts ?? 0) + 1,
            }),
          )
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

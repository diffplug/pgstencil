import { diagnostic, diagnosticError } from 'pgstencil/diagnostics';
import Stripe from 'stripe';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { token, type Time, type RandomSource } from 'pgstencil';
import type { BillingDB } from './db.ts';
export type { BillingDB } from './db.ts';
export { Stripe };
export const STRIPE_API_VERSION = Stripe.API_VERSION;
/** Several Stripe Prices for one plan, and the server-side choice of which one checkout offers. */
export interface PlanPrices {
  /** Every Price that grants this plan: the one offered now, earlier ones, and any later steps. */
  recognized: readonly string[];
  /** Chooses the Price a new checkout offers; it must be one of `recognized`. */
  offer: (billing: Billing<string>) => string | Promise<string>;
}
export interface BillingConfig<P extends string = string> {
  /** Plan name → its Stripe Price, or several Prices with a choice of which to offer. */
  prices: Record<P, string | PlanPrices>;
  trialDays: number;
  /** Opt in to Stripe Managed Payments (merchant of record) on every Checkout Session. */
  managedPayments?: boolean;
  /**
   * Opt in to Stripe Tax on every Checkout Session: Checkout collects the
   * address tax needs and saves it on the customer. Not with `managedPayments`,
   * which calculates tax itself.
   */
  automaticTax?: boolean;
  webhookSecret: string;
  live: boolean;
  origin: string;
  returnPath?: string;
  portalConfiguration?: string;
  /** Origins this billing setup redirects the browser to; defaults to Stripe's. */
  redirectOrigins?: readonly string[];
}
/** A synchronized subscription row, as `status(owner).subscription` reads it. */
export type BillingSubscription = Selectable<BillingDB['subscriptions']>;
/** What `webhook` resolved an event to, read inside its transaction. */
export interface WebhookContext {
  /** The billing owner the event names through its `customer`; null for one pgstencil did not create. */
  ownerId: string | null;
  /**
   * For a `customer.subscription.*` event, that subscription's synchronized
   * row after this event's resync, its `end_reason` included; else null.
   */
  subscription: BillingSubscription | null;
}
/** Application database effects that join a webhook's commit and retry boundary. */
export type WebhookApply = (
  event: Stripe.Event,
  trx: Transaction<BillingDB>,
  context: WebhookContext,
) => Promise<void>;
/** A completed subscription Checkout, read from its verified completion event. */
export interface CompletedCheckout {
  /** The operation ID `checkout` returned. */
  operation: string;
  ownerId: string;
  /** The plan name the Checkout was opened for. */
  plan: string;
  priceId: string;
  /** The `ref` passed to `checkout`, or null. */
  ref: string | null;
}
/**
 * What an application can branch on: `unexpected-price`, a checkout's
 * `expectPrice` refusing the Price it would charge.
 */
export type BillingErrorCode = 'unexpected-price';
export class BillingError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code?: BillingErrorCode,
  ) {
    super(message);
  }
}
const unexpectedPrice = () =>
  new BillingError(
    'The price changed. Review it and try again.',
    409,
    'unexpected-price',
  );
const OPEN = ['pending', 'open'];
/** Subscriptions that never held a purchase, or that Stripe no longer lists. */
const UNPURCHASED = ['incomplete', 'incomplete_expired', 'missing'];
const PLAN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Migrations 006 and 008 check the same pattern on `checkouts.ref` and `subscriptions.end_reason`. */
const LABEL = /^[a-z0-9:-]{1,40}$/;
/**
 * The statuses of a subscription Stripe still holds, paid up or not: an owner
 * with one cannot check out again, and access needs exactly one. Migration
 * 007's `owner_access` view lists the same statuses.
 */
export const SUBSCRIBED: readonly string[] = Object.freeze([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
]);
const idOf = (value: string | { id: string } | null): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null);
const instant = (seconds: number) => new Date(seconds * 1000);
/** Stripe idempotency keys expire after 24h; refuse to reuse one near that edge. */
const RETRY_WINDOW_MS = 23 * 3600000;
const STRIPE_REDIRECT_ORIGINS = [
  'https://checkout.stripe.com',
  'https://billing.stripe.com',
];

function checkRefundDays(refundDays: number): void {
  if (!Number.isInteger(refundDays) || refundDays < 0 || refundDays > 730)
    throw new Error('refundDays must be an integer between 0 and 730');
}
/** What the purchase rule reads: a synchronized row, as `status(owner).subscription`. */
export interface PurchaseFacts {
  status: string;
  started_at: Date | null;
  ended_at: Date | null;
  trial_end: Date | null;
}
/**
 * Whether a subscription is a completed purchase, and if not, why:
 * `unpurchased` (Stripe never completed its first payment, or no longer
 * lists it), `ended-in-trial` (never charged), or `refund-window` (ended
 * within `refundDays` of starting, which is how an application's refund
 * looks: pgstencil cannot tell it from an immediate cancellation).
 */
export type PurchaseStanding =
  'purchased' | 'unpurchased' | 'ended-in-trial' | 'refund-window';
/**
 * The rule `purchaseCounts` applies, for one subscription: pure, with no
 * I/O. Accepts a synchronized row or a Stripe subscription, such as a
 * webhook event's object. A day is 24 hours.
 */
export function purchaseStanding(
  subscription: PurchaseFacts | Stripe.Subscription,
  options: { refundDays: number },
): PurchaseStanding {
  checkRefundDays(options.refundDays);
  const facts: PurchaseFacts =
    'start_date' in subscription
      ? {
          status: subscription.status,
          started_at: instant(subscription.start_date),
          ended_at:
            subscription.ended_at === null
              ? null
              : instant(subscription.ended_at),
          trial_end:
            subscription.trial_end === null
              ? null
              : instant(subscription.trial_end),
        }
      : subscription;
  if (UNPURCHASED.includes(facts.status)) return 'unpurchased';
  const ended = facts.ended_at?.getTime();
  if (ended === undefined) return 'purchased';
  if (facts.trial_end && ended <= facts.trial_end.getTime())
    return 'ended-in-trial';
  if (
    facts.started_at &&
    ended < facts.started_at.getTime() + options.refundDays * 86_400_000
  )
    return 'refund-window';
  return 'purchased';
}

/** Owns billing state; HTTP adapters supply an already-authorized owner ID. */
export class Billing<P extends string = string> {
  readonly db: Kysely<BillingDB>;
  readonly returnUrl: string;
  /** Hosts a caller must allow in its CSP form-action for Checkout to work. */
  readonly redirectOrigins: readonly string[];
  /** Plan name → the Prices that grant it and the choice of which to offer. */
  private readonly offers: ReadonlyMap<string, PlanPrices>;
  /** Every recognized Price → the plan it grants. */
  private readonly plans: ReadonlyMap<string, P>;
  constructor(
    db: Kysely<BillingDB>,
    readonly stripe: Stripe,
    readonly time: Time,
    readonly random: RandomSource,
    readonly config: BillingConfig<P>,
  ) {
    this.db = db.withSchema('pgstencil_billing');
    if (
      !Number.isInteger(config.trialDays) ||
      config.trialDays < 0 ||
      config.trialDays > 730
    )
      throw new Error('trialDays must be an integer between 0 and 730');
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
    const offers = new Map<string, PlanPrices>();
    const plans = new Map<string, P>();
    for (const [plan, value] of Object.entries(config.prices) as [
      P,
      string | PlanPrices,
    ][]) {
      if (!PLAN_NAME.test(plan))
        throw new Error('Plan names must be 1-64 letters, digits, _ or -');
      const prices =
        typeof value === 'string'
          ? { recognized: [value], offer: () => value }
          : value;
      if (!prices.recognized.length || typeof prices.offer !== 'function')
        throw new Error(`Plan ${plan} needs a Stripe price`);
      for (const id of prices.recognized) {
        if (typeof id !== 'string' || !id)
          throw new Error(`Plan ${plan} has an empty Stripe price`);
        if (plans.has(id))
          throw new Error('Each Stripe price must belong to exactly one plan');
        plans.set(id, plan);
      }
      offers.set(plan, prices);
    }
    if (!offers.size) throw new Error('Configure at least one plan');
    this.offers = offers;
    this.plans = plans;
    if (
      config.managedPayments !== undefined &&
      typeof config.managedPayments !== 'boolean'
    )
      throw new Error('managedPayments must be a boolean');
    if (
      config.automaticTax !== undefined &&
      typeof config.automaticTax !== 'boolean'
    )
      throw new Error('automaticTax must be a boolean');
    if (config.automaticTax && config.managedPayments)
      throw new Error(
        'Managed Payments calculates tax itself; do not also enable automaticTax',
      );
  }
  /**
   * The configured plan a Price grants, without I/O. A Price removed from the
   * configuration no longer maps to a plan, so it reports null, as does null.
   */
  planOf(priceId: string | null | undefined): P | null {
    return (priceId && this.plans.get(priceId)) || null;
  }
  /** The Price a checkout started now would offer for `plan`. Unknown plans throw BillingError(400). */
  async offeredPrice(plan: string): Promise<string> {
    const prices = this.offers.get(plan);
    if (!prices) throw new BillingError('Unknown plan.', 400);
    const price = await prices.offer(this as Billing<string>);
    if (!prices.recognized.includes(price))
      throw new Error(`Plan ${plan} offered a price it does not recognize`);
    return price;
  }
  private assertRetryable(startedAt: Date, what: string): void {
    if (this.time.now().getTime() - startedAt.getTime() >= RETRY_WINDOW_MS)
      throw new BillingError(
        `${what} creation needs reconciliation before retrying.`,
      );
  }
  /**
   * Ensures the owner has a billing account row. Safe to call on every view.
   * `email` is null for an owner without one: Stripe Checkout then collects
   * it. The first call's email is the Stripe customer's; later calls keep it.
   */
  async account(ownerId: string, email: string | null): Promise<void> {
    if (!ownerId || email === '')
      throw new Error('Billing requires an owner, and an email or null');
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
  private async customer(
    ownerId: string,
    email: string | null,
  ): Promise<string> {
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
      {
        // Without one, Checkout asks the buyer and sets it on the customer.
        ...(account.email ? { email: account.email } : {}),
        metadata: { pgstencil_owner: ownerId },
      },
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
    /** The owner's email, or null to let Checkout collect it. */
    email: string | null,
    /** Any configured plan name; untrusted input is fine, since unknown names throw BillingError(400). */
    plan: string,
    options: {
      /**
       * An attribution label, such as the link that led here: 1-40 of
       * `a-z`, `0-9`, `:` and `-`, else BillingError(400). An open
       * Checkout keeps the ref it was opened with.
       */
      ref?: string | undefined;
      /**
       * Expire an open checkout for another plan, instead of refusing with
       * BillingError until `cancelCheckout`.
       */
      replace?: boolean | undefined;
      /**
       * Whether the application accepts charging `priceId`, such as the
       * Price its page showed: checked against the Price this checkout would
       * charge, a reused open checkout's included, before any Stripe write
       * and again under the owner's lock. A refusal throws BillingError with
       * code `unexpected-price`, and expires a reused open checkout so the
       * next one starts at the offered Price. May be called more than once.
       */
      expectPrice?: ((priceId: string) => boolean) | undefined;
    } = {},
  ): Promise<{
    id: string;
    url: string;
    /** The Price this checkout charges. */
    priceId: string;
  }> {
    const ref = options.ref ?? null;
    if (ref !== null && (typeof ref !== 'string' || !LABEL.test(ref)))
      throw new BillingError('Invalid checkout ref.', 400);
    const { replace, expectPrice } = options;
    // Resolved before any Stripe write: an unknown plan or a bad offer creates nothing.
    const price = await this.offeredPrice(plan);
    if (replace || expectPrice) {
      let open = await this.openCheckout(ownerId);
      if (open && open.plan !== plan && replace) {
        await this.cancelCheckout(ownerId);
        open = undefined;
      }
      const reused = open?.plan === plan ? open : undefined;
      if (expectPrice && !expectPrice(reused?.price_id ?? price)) {
        // Left open, it would be reused, and refused, until it expires.
        if (reused) await this.cancelCheckout(ownerId);
        throw unexpectedPrice();
      }
    }
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
      if (existing && existing.plan !== plan)
        throw new BillingError(
          'Cancel the open checkout before choosing another plan.',
        );
      // Rechecked under the lock: a concurrent request may have changed it.
      if (expectPrice && !expectPrice(existing?.price_id ?? price))
        throw unexpectedPrice();
      if (existing) return existing;
      return trx
        .insertInto('checkouts')
        .values({
          id: token(this.random),
          owner_id: ownerId,
          plan,
          price_id: price,
          trial_days: account.trial_used_at ? 0 : this.config.trialDays,
          status: 'pending',
          session_id: null,
          url: null,
          created_at: this.time.now(),
          expires_at: new Date(this.time.now().getTime() + 60 * 60000),
          ref,
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
      // Only a stored ref is sent, so a retry repeats it and no ref adds no key.
      const ref = operation.ref ? { pgstencil_ref: operation.ref } : {};
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer,
          client_reference_id: ownerId,
          line_items: [{ price: operation.price_id, quantity: 1 }],
          payment_method_collection: 'always',
          payment_method_types: ['card'],
          ...(this.config.managedPayments
            ? { managed_payments: { enabled: true } }
            : {}),
          // The customer pgstencil created has no address; Stripe requires
          // Checkout to save the one it collects before it can calculate tax.
          ...(this.config.automaticTax
            ? {
                automatic_tax: { enabled: true },
                customer_update: { address: 'auto' as const },
              }
            : {}),
          subscription_data: {
            metadata: {
              pgstencil_owner: ownerId,
              pgstencil_operation: operation.id,
              ...ref,
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
          metadata: { pgstencil_operation: operation.id, ...ref },
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
    return {
      id: operation.id,
      url: session.url ?? operation.url!,
      priceId: operation.price_id,
    };
  }
  private openCheckout(ownerId: string) {
    return this.db
      .selectFrom('checkouts')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('status', 'in', OPEN)
      .executeTakeFirst();
  }
  async cancelCheckout(ownerId: string): Promise<void> {
    const operation = await this.openCheckout(ownerId);
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
  /**
   * What a verified `checkout.session.completed` event completed, including
   * its `ref`; null for any other event, or a Checkout pgstencil did not open.
   * Inside `webhook`'s `apply`, pass its transaction: the callback runs once per
   * event, so counting there never counts a redelivery.
   */
  async completedCheckout(
    event: Stripe.Event,
    trx: Transaction<BillingDB> | Kysely<BillingDB> = this.db,
  ): Promise<CompletedCheckout | null> {
    if (event.type !== 'checkout.session.completed') return null;
    const session = event.data.object;
    const operationId = session.metadata?.pgstencil_operation;
    if (session.mode !== 'subscription' || !operationId) return null;
    const row = await trx
      .selectFrom('checkouts')
      .selectAll()
      .where('id', '=', operationId)
      .where('session_id', '=', session.id)
      .executeTakeFirst();
    if (!row || session.client_reference_id !== row.owner_id) return null;
    return {
      operation: row.id,
      ownerId: row.owner_id,
      plan: row.plan,
      priceId: row.price_id,
      ref: row.ref,
    };
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
        started_at: instant(sub.start_date),
        ended_at: sub.ended_at === null ? null : instant(sub.ended_at),
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
            started_at: eb.ref('excluded.started_at'),
            ended_at: eb.ref('excluded.ended_at'),
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
  /**
   * Ends `ownerId`'s subscription `subscriptionId` in Stripe at once, with no
   * proration and no final invoice, and records `reason` (1-40 of `a-z`,
   * `0-9`, `:` and `-`) as its row's `end_reason` before releasing the
   * owner's lock, so the `customer.subscription.deleted` webhook reads it;
   * then reconciles. Returns false, changing nothing, for one already ended.
   * A subscription that is not the owner's throws BillingError(404).
   */
  async end(
    ownerId: string,
    subscriptionId: string,
    options: { reason: string },
  ): Promise<boolean> {
    const { reason } = options;
    if (typeof reason !== 'string' || !LABEL.test(reason))
      throw new Error('An end reason is 1-40 of a-z, 0-9, : and -');
    const ended = await this.db.transaction().execute(async (trx) => {
      const account = await trx
        .selectFrom('accounts')
        .select('owner_id')
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      if (account) await this.synchronize(trx, ownerId);
      const row = await trx
        .selectFrom('subscriptions')
        .select('status')
        .where('id', '=', subscriptionId)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      if (!row) throw new BillingError('Subscription not found.', 404);
      if (!SUBSCRIBED.includes(row.status)) return false;
      await this.stripe.subscriptions.cancel(subscriptionId, {
        prorate: false,
        invoice_now: false,
      });
      await trx
        .updateTable('subscriptions')
        .set({ end_reason: reason })
        .where('id', '=', subscriptionId)
        .execute();
      return true;
    });
    if (ended) await this.reconcile(ownerId);
    return ended;
  }
  async reconcile(ownerId: string): Promise<void> {
    await this.db
      .transaction()
      .execute((trx) => this.synchronize(trx, ownerId));
  }
  /**
   * Reconciles up to `limit` owners, in a random order, holding an `active`
   * or `trialing` subscription yet no access by `owner_access`: a renewal or
   * trial conversion whose webhook never arrived, or more than one current
   * subscription. For a scheduled job; every chosen owner is tried.
   */
  async reconcileStale(options: { limit: number }): Promise<{
    reconciled: string[];
    failed: { ownerId: string; error: unknown }[];
  }> {
    const { limit } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('limit must be an integer between 1 and 1000');
    const now = this.time.now();
    // Seeded from the injected randomness, so tests replay one order.
    const seed = token(this.random);
    const owners = await this.db
      .selectFrom('subscriptions as s')
      .select('s.owner_id')
      .where('s.status', 'in', ['active', 'trialing'])
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('owner_access as a')
              .whereRef('a.owner_id', '=', 's.owner_id')
              .where('a.access_until', '>', now),
          ),
        ),
      )
      .groupBy('s.owner_id')
      .orderBy(sql`md5(s.owner_id || ${seed})`)
      .limit(limit)
      .execute();
    const reconciled: string[] = [];
    const failed: { ownerId: string; error: unknown }[] = [];
    for (const { owner_id: ownerId } of owners)
      await this.reconcile(ownerId).then(
        () => reconciled.push(ownerId),
        (error: unknown) => failed.push({ ownerId, error }),
      );
    return { reconciled, failed };
  }
  async status(ownerId: string) {
    const [account, subscriptions, entitled] = await Promise.all([
      this.db
        .selectFrom('accounts')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .executeTakeFirst(),
      this.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .execute(),
      // The access rule lives in the view, so application SQL reads the same one.
      this.db
        .selectFrom('owner_access')
        .select('access_until')
        .where('owner_id', '=', ownerId)
        .executeTakeFirst(),
    ]);
    const current = subscriptions.filter((sub) =>
      SUBSCRIBED.includes(sub.status),
    );
    const subscription = current[0] ?? subscriptions[0] ?? null;
    const until =
      subscription?.status === 'trialing'
        ? subscription.trial_end
        : subscription?.period_end;
    const access =
      !!entitled?.access_until && entitled.access_until > this.time.now();
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
  /**
   * Completed purchases per Price, from synchronized rows without network
   * requests: the subscriptions whose `purchaseStanding` is `purchased`.
   * Stripe does not tell pgstencil about refunds: an application that
   * refunds also cancels immediately, inside the refund window.
   */
  async purchaseCounts(
    prices: readonly string[],
    options: { refundDays: number },
  ): Promise<Record<string, number>> {
    const { refundDays } = options;
    checkRefundDays(refundDays);
    const counts: Record<string, number> = Object.fromEntries(
      prices.map((price) => [price, 0]),
    );
    if (!prices.length) return counts;
    const rows = await this.db
      .selectFrom('subscriptions')
      .select(['price_id', (eb) => eb.fn.countAll<string>().as('count')])
      .where('price_id', 'in', prices)
      .where('status', 'not in', UNPURCHASED)
      .where((eb) =>
        eb.or([
          eb('ended_at', 'is', null),
          eb.and([
            eb.or([
              eb('trial_end', 'is', null),
              eb('ended_at', '>', eb.ref('trial_end')),
            ]),
            eb.or([
              eb('started_at', 'is', null),
              eb(
                'ended_at',
                '>=',
                // Hours, not days: a day is 24 hours in every session time zone, as in purchaseStanding.
                sql<Date>`started_at + make_interval(hours => ${refundDays * 24})`,
              ),
            ]),
          ]),
        ]),
      )
      .groupBy('price_id')
      .execute();
    for (const row of rows) counts[row.price_id] = Number(row.count);
    return counts;
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
    apply?: WebhookApply,
  ): Promise<void> {
    let event: Stripe.Event;
    try {
      event = await this.verifyWebhook(body, signature);
    } catch (error) {
      diagnostic('billing.webhook.failed', {
        stage: 'transport',
        reason: 'request_rejected',
        ...diagnosticError(error),
      });
      throw error;
    }
    diagnostic('billing.webhook.received', { stripeEventId: event.id });
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
        let ownerId: string | null = null;
        if (customer) {
          const account = await trx
            .selectFrom('accounts')
            .select('owner_id')
            .where('customer_id', '=', customer)
            .executeTakeFirst();
          ownerId = account?.owner_id ?? null;
          if (ownerId) await this.synchronize(trx, ownerId);
        }
        if (apply) {
          const subscription =
            ownerId && event.type.startsWith('customer.subscription.')
              ? ((await trx
                  .selectFrom('subscriptions')
                  .selectAll()
                  .where('id', '=', (event.data.object as { id: string }).id)
                  .where('owner_id', '=', ownerId)
                  .executeTakeFirst()) ?? null)
              : null;
          await apply(event, trx, { ownerId, subscription });
        }
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
      diagnostic('billing.webhook.processed', { stripeEventId: event.id });
    } catch (error) {
      diagnostic('billing.webhook.failed', {
        stripeEventId: event.id,
        stage: 'database',
        reason: 'unexpected_error',
        ...diagnosticError(error),
      });
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

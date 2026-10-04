import {
  withDiagnostics,
  type DiagnosticRecord,
} from '../../packages/pgstencil/src/diagnostics.ts';
import { test, expect } from 'vitest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { connectDatabase } from '../../packages/pgstencil/src/database.ts';
import {
  Billing,
  BillingError,
  STRIPE_API_VERSION,
  type BillingConfig,
  type BillingDB,
} from '../../packages/stripe/src/index.ts';
import { appMigrations } from '../../examples/login/src/migrations.ts';
import {
  createStripeDev,
  type StripeDevOptions,
} from '../../packages/stripe/src/testing.ts';
import { stableJson } from '../../packages/pgstencil/src/snapshots.ts';

async function fixture(
  options: {
    config?: (
      dev: Awaited<ReturnType<typeof createStripeDev>>,
    ) => Partial<BillingConfig>;
    dev?: StripeDevOptions;
  } = {},
) {
  const context = await createTestContext({
    migrations: appMigrations,
  });
  const dev = await createStripeDev(
    context.time,
    context.random,
    undefined,
    options.dev,
  );
  const db = connectDatabase<BillingDB>(context.database.url);
  const config: BillingConfig = {
    prices: dev.prices,
    trialDays: 14,
    webhookSecret: dev.webhookSecret,
    live: false,
    origin: 'https://example.test',
    ...options.config?.(dev),
  };
  const billing = new Billing(
    db,
    dev.stripe,
    context.time,
    context.random,
    config,
  );
  return {
    ...context,
    dev,
    db,
    config,
    billing,
    async start(plan = 'monthly', owner = 'alice') {
      const checkout = await billing.checkout(
        owner,
        `${owner}@example.test`,
        plan,
      );
      const session = [...dev.checkouts.values()].find(
        (s) => s.url === checkout.url,
      )!;
      return { checkout, session };
    },
    async deliver() {
      while (dev.events.length) {
        const { body, signature } = dev.signed(dev.events[0]!);
        await billing.webhook(body, signature);
        dev.events.shift();
      }
    },
    async close() {
      await db.destroy();
      await dev.close();
      await context.close();
    },
  };
}
const billingTest = test.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({}, use) => {
    const f = await fixture();
    try {
      await use(f);
    } finally {
      await f.close();
    }
  },
});

billingTest(
  'application fulfillment and the webhook ledger share one transaction',
  async ({ f }) => {
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    const signed = f.dev.signed(f.dev.events[0]!);
    await expect(
      f.billing.webhook(signed.body, signed.signature, async (_event, trx) => {
        await trx
          .updateTable('accounts')
          .set({ email: 'rolled-back@example.test' })
          .where('owner_id', '=', 'alice')
          .execute();
        throw new Error('fulfillment failed');
      }),
    ).rejects.toThrow('fulfillment failed');
    expect(
      (
        await f.billing.db
          .selectFrom('accounts')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).email,
    ).toBe('alice@example.test');
    expect((await f.billing.status('alice')).access).toBe(false);
    let calls = 0;
    const apply = async () => {
      calls++;
    };
    await f.billing.webhook(signed.body, signed.signature, apply);
    await f.billing.webhook(signed.body, signed.signature, apply);
    expect(calls).toBe(1);
    expect((await f.billing.status('alice')).access).toBe(true);
  },
);

billingTest(
  'yes-card trial: signup and an open checkout grant nothing; confirmed trial ends exactly on time',
  async ({ f }) => {
    await f.billing.account('alice', 'alice@example.test');
    expect((await f.billing.status('alice')).access).toBe(false);
    const { checkout, session } = await f.start();
    await f.billing.confirmCheckout('alice', checkout.id);
    expect((await f.billing.status('alice')).access).toBe(false);
    const creation = f.dev.requests.find(
      (r) => r.path === '/v1/checkout/sessions',
    )!;
    expect(creation.body).toMatchObject({
      payment_method_collection: 'always',
      'payment_method_types[0]': 'card',
      'subscription_data[trial_period_days]': '14',
    });
    const sub = f.dev.completeCheckout(session.id);
    await f.deliver();
    expect(await f.billing.status('alice')).toMatchObject({
      access: true,
      trialEligible: false,
      plan: 'monthly',
      accessUntil: new Date('2020-01-15T00:00:00Z'),
    });
    await expect(
      stableJson(await f.billing.status('alice')),
    ).toMatchFileSnapshot('./snapshots/billing/trial.json');
    f.time.advanceDays(14);
    expect((await f.billing.status('alice')).access).toBe(false);
    f.dev.transition(sub.id, 'renew');
    await f.deliver();
    expect(await f.billing.status('alice')).toMatchObject({
      access: true,
      accessUntil: new Date('2020-02-15T00:00:00Z'),
    });
  },
);

billingTest(
  'yearly discount uses the configured price; canceled accounts cannot repeat a trial',
  async ({ f }) => {
    const { session } = await f.start('yearly');
    const sub = f.dev.completeCheckout(session.id);
    await f.deliver();
    expect(
      f.dev.requests.find((r) => r.path === '/v1/checkout/sessions')!.body[
        'line_items[0][price]'
      ],
    ).toBe(f.dev.prices.yearly);
    f.dev.transition(sub.id, 'cancel-at-period-end');
    await f.deliver();
    expect((await f.billing.status('alice')).access).toBe(true);
    f.time.advanceDays(14);
    expect((await f.billing.status('alice')).access).toBe(false);
    f.dev.transition(sub.id, 'cancel');
    await f.deliver();
    const second = await f.start('yearly');
    const retry = await f.start('yearly');
    expect(retry.checkout.id).toBe(second.checkout.id);
    const creations = f.dev.requests.filter(
      (r) => r.path === '/v1/checkout/sessions',
    );
    expect(
      creations.at(-1)!.body['subscription_data[trial_period_days]'],
    ).toBeUndefined();
    f.dev.completeCheckout(second.session.id);
    await f.deliver();
    expect(await f.billing.status('alice')).toMatchObject({
      access: true,
      trialEligible: false,
      accessUntil: new Date('2021-01-15T00:00:00Z'),
    });
  },
);

billingTest(
  'failed first payment revokes access and a successful retry restores it',
  async ({ f }) => {
    const { session } = await f.start();
    const sub = f.dev.completeCheckout(session.id);
    await f.deliver();
    f.time.advanceDays(14);
    f.dev.transition(sub.id, 'payment-failed');
    await f.deliver();
    expect((await f.billing.status('alice')).access).toBe(false);
    await expect(f.start()).rejects.toThrow('Manage billing');
    expect(await f.billing.portal('alice')).toContain('/portal/');
    f.dev.transition(sub.id, 'renew');
    await f.deliver();
    expect((await f.billing.status('alice')).access).toBe(true);
  },
);

billingTest(
  'lost creation responses and concurrent clicks reuse durable idempotency keys',
  async ({ f }) => {
    f.dev.failNext('/v1/customers', true);
    await expect(f.start()).rejects.toThrow();
    f.dev.failNext('/v1/checkout/sessions', true);
    await expect(f.start()).rejects.toThrow();
    const results = await Promise.all([f.start(), f.start(), f.start()]);
    expect(new Set(results.map((r) => r.checkout.id)).size).toBe(1);
    expect(f.dev.customers.size).toBe(1);
    expect(f.dev.checkouts.size).toBe(1);
    const customerKeys = f.dev.requests
      .filter((r) => r.path === '/v1/customers')
      .map((r) => r.key);
    expect(new Set(customerKeys).size).toBe(1);
  },
);

billingTest(
  'ambiguous customer creation beyond the retry window fails closed',
  async ({ f }) => {
    f.dev.failNext('/v1/customers', true);
    await expect(f.start()).rejects.toThrow();
    f.time.advanceHours(23);
    await expect(f.start()).rejects.toThrow('reconciliation');
    expect(f.dev.customers.size).toBe(1);
  },
);

billingTest(
  'duplicate and out-of-order webhooks reconcile authoritative state exactly once',
  async ({ f }) => {
    const { session } = await f.start();
    const sub = f.dev.completeCheckout(session.id);
    const old = f.dev.events[1]!;
    const canceled = f.dev.transition(sub.id, 'cancel');
    const latest = f.dev.signed(canceled);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        f.billing.webhook(latest.body, latest.signature),
      ),
    );
    const stale = f.dev.signed(old);
    await f.billing.webhook(stale.body, stale.signature);
    expect((await f.billing.status('alice')).access).toBe(false);
    const events = await f.billing.db
      .selectFrom('events')
      .selectAll()
      .orderBy('id')
      .execute();
    expect(events).toHaveLength(2);
    expect(
      events.every((e) => e.attempts === 1 && !e.failed && e.processed_at),
    ).toBe(true);
  },
);

billingTest(
  'an upstream outage rolls back entitlement changes and a failed event can retry',
  async ({ f }) => {
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    const signed = f.dev.signed(f.dev.events[0]!);
    f.dev.failNext('/v1/subscriptions');
    await expect(
      f.billing.webhook(signed.body, signed.signature),
    ).rejects.toThrow();
    expect((await f.billing.status('alice')).access).toBe(false);
    expect(
      await f.billing.db.selectFrom('events').selectAll().executeTakeFirst(),
    ).toMatchObject({ failed: true, attempts: 1, processed_at: null });
    await f.billing.webhook(signed.body, signed.signature);
    expect((await f.billing.status('alice')).access).toBe(true);
    expect(
      await f.billing.db.selectFrom('events').selectAll().executeTakeFirst(),
    ).toMatchObject({ failed: false, attempts: 2 });
  },
);

billingTest(
  'checkout ownership, card policy, signatures, mode and API version are enforced',
  async ({ f }) => {
    const { checkout, session } = await f.start();
    await expect(
      f.billing.confirmCheckout('mallory', checkout.id),
    ).rejects.toThrow('not found');
    await expect(f.billing.portal('mallory')).rejects.toThrow();
    await expect(f.start('yearly')).rejects.toThrow('Cancel the open checkout');
    f.dev.completeCheckout(session.id);
    const event = f.dev.events[0]!;
    const signed = f.dev.signed(event);
    await expect(
      f.billing.webhook(signed.body + ' ', signed.signature),
    ).rejects.toThrow();
    for (const invalid of [
      { ...event, livemode: true },
      { ...event, api_version: '2000-01-01' },
      { ...event, account: 'acct_other' },
    ]) {
      const s = f.dev.signed(invalid as typeof event);
      await expect(f.billing.webhook(s.body, s.signature)).rejects.toThrow(
        'configuration',
      );
    }
    expect(event.api_version).toBe(STRIPE_API_VERSION);
    f.time.advanceMilliseconds(301000);
    await expect(
      f.billing.webhook(signed.body, signed.signature),
    ).rejects.toThrow('Timestamp');
  },
);

billingTest(
  'expired and canceled checkouts can be replaced without spending the trial',
  async ({ f }) => {
    const first = await f.start();
    f.time.advanceMilliseconds(60 * 60000);
    await expect(f.start()).rejects.toThrow('expired');
    const second = await f.start('yearly');
    expect(second.checkout.id).not.toBe(first.checkout.id);
    await f.billing.cancelCheckout('alice');
    await f.start('monthly');
    expect((await f.billing.status('alice')).trialEligible).toBe(true);
    expect((await f.billing.status('alice')).access).toBe(false);
  },
);

billingTest(
  'payment diagnostics keep verified event IDs and report failure before recovery without payloads',
  async ({ f }) => {
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    const event = f.dev.events[0]!;
    const signed = f.dev.signed(event);
    const records: DiagnosticRecord[] = [];
    const options = {
      sink: (record: DiagnosticRecord) => records.push(record),
      time: f.time,
    };
    await expect(
      withDiagnostics(options, () =>
        f.billing.webhook(signed.body, signed.signature, async () => {
          throw new Error('private payment payload');
        }),
      ),
    ).rejects.toThrow();
    expect(records.map((r) => r.event)).toEqual([
      'billing.webhook.received',
      'billing.webhook.failed',
    ]);
    expect(records.every((r) => r.stripeEventId === event.id)).toBe(true);
    await withDiagnostics(options, () =>
      f.billing.webhook(signed.body, signed.signature),
    );
    expect(records.at(-1)?.event).toBe('billing.webhook.processed');
    expect(JSON.stringify(records)).not.toContain('private payment payload');
    expect(JSON.stringify(records)).not.toContain('alice@example.test');
    expect(JSON.stringify(records)).not.toContain(signed.signature);
  },
);

const ladder = ['price_founding_50', 'price_founding_60'];
const seatsPerCohort = 2;
const foundingTest = test.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({}, use) => {
    const f = await fixture({
      dev: { recurring: { [ladder[0]!]: 'year', [ladder[1]!]: 'year' } },
      config: (dev) => ({
        prices: {
          ...dev.prices,
          founding: {
            recognized: ladder,
            async offer(billing) {
              const sold = await billing.purchaseCounts(ladder, {
                refundDays: 30,
              });
              return (
                ladder.find((price) => sold[price]! < seatsPerCohort) ??
                ladder.at(-1)!
              );
            },
          },
        },
        trialDays: 0,
        managedPayments: true,
      }),
    });
    try {
      await use(f);
    } finally {
      await f.close();
    }
  },
});
const checkoutPrices = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.dev.requests
    .filter((r) => r.path === '/v1/checkout/sessions')
    .map((r) => r.body['line_items[0][price]']);

foundingTest(
  'named plans: the server picks the founding price, an open checkout keeps it, and a refund returns the seat',
  async ({ f }) => {
    const buy = async (owner: string) => {
      const { session } = await f.start('founding', owner);
      f.dev.completeCheckout(session.id);
      await f.deliver();
    };
    await buy('alice');
    const creation = f.dev.requests.find(
      (r) => r.path === '/v1/checkout/sessions',
    )!.body;
    expect(creation).toMatchObject({
      'managed_payments[enabled]': 'true',
      'line_items[0][price]': ladder[0],
    });
    expect(creation['subscription_data[trial_period_days]']).toBeUndefined();
    expect(await f.billing.status('alice')).toMatchObject({
      access: true,
      plan: 'founding',
      trialDays: 0,
      accessUntil: new Date('2021-01-01T00:00:00Z'),
    });
    // Erin opens at the first cohort's price, then the cohort sells out.
    const erin = await f.start('founding', 'erin');
    await buy('bob');
    expect(await f.billing.offeredPrice('founding')).toBe(ladder[1]);
    const retry = await f.start('founding', 'erin');
    expect(retry.checkout.id).toBe(erin.checkout.id);
    f.dev.completeCheckout(erin.session.id);
    await f.deliver();
    expect(await f.billing.purchaseCounts(ladder, { refundDays: 30 })).toEqual({
      [ladder[0]!]: 3,
      [ladder[1]!]: 0,
    });
    await buy('carol');
    expect(checkoutPrices(f)).toEqual([
      ladder[0],
      ladder[0],
      ladder[0],
      ladder[1],
    ]);
    // A refund cancels at once, inside the window: the seat returns.
    const alice = await f.billing.status('alice');
    f.dev.transition(alice.subscription!.id, 'cancel');
    await f.deliver();
    expect((await f.billing.status('alice')).access).toBe(false);
    // A founder who leaves after the refund window keeps the seat counted.
    f.time.advanceDays(31);
    const bob = await f.billing.status('bob');
    f.dev.transition(bob.subscription!.id, 'cancel');
    await f.deliver();
    expect(await f.billing.purchaseCounts(ladder, { refundDays: 30 })).toEqual({
      [ladder[0]!]: 2,
      [ladder[1]!]: 1,
    });
    expect(
      await f.billing.purchaseCounts([...ladder, 'price_unsold'], {
        refundDays: 0,
      }),
    ).toEqual({ [ladder[0]!]: 3, [ladder[1]!]: 1, price_unsold: 0 });
  },
);

billingTest(
  'a trial canceled before it ends, or a first payment never completed, is not a purchase',
  async ({ f }) => {
    const { session } = await f.start();
    const sub = f.dev.completeCheckout(session.id);
    await f.deliver();
    const count = () =>
      f.billing.purchaseCounts([f.dev.prices.monthly], { refundDays: 0 });
    expect(await count()).toEqual({ [f.dev.prices.monthly]: 1 });
    f.time.advanceDays(3);
    f.dev.transition(sub.id, 'cancel');
    await f.deliver();
    expect(await count()).toEqual({ [f.dev.prices.monthly]: 0 });
    // Rows Stripe never completed or no longer lists hold no seat; a row
    // synchronized before started_at existed still counts.
    const row = (id: string, status: string, started_at: Date | null) => ({
      id,
      owner_id: 'alice',
      price_id: f.dev.prices.monthly,
      status,
      started_at,
      ended_at: null,
      period_end: f.time.now(),
      trial_end: null,
      cancel_at_period_end: false,
      updated_at: f.time.now(),
    });
    await f.billing.db
      .insertInto('subscriptions')
      .values([
        row('sub_incomplete', 'incomplete', f.time.now()),
        row('sub_expired', 'incomplete_expired', f.time.now()),
        row('sub_missing', 'missing', f.time.now()),
        row('sub_legacy', 'active', null),
      ])
      .execute();
    expect(await count()).toEqual({ [f.dev.prices.monthly]: 1 });
    await expect(
      f.billing.purchaseCounts([], { refundDays: -1 }),
    ).rejects.toThrow('refundDays');
  },
);

billingTest(
  'a retired price keeps granting its plan and is never offered',
  async ({ f }) => {
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    await f.deliver();
    const next = new Billing(f.db, f.dev.stripe, f.time, f.random, {
      ...f.config,
      prices: {
        monthly: {
          recognized: ['price_dev_monthly_v2', f.dev.prices.monthly],
          offer: () => 'price_dev_monthly_v2',
        },
        yearly: f.dev.prices.yearly,
      },
    });
    await next.reconcile('alice');
    expect(await next.status('alice')).toMatchObject({
      access: true,
      plan: 'monthly',
    });
    expect(await next.offeredPrice('monthly')).toBe('price_dev_monthly_v2');
    // A price dropped from the configuration fails synchronization closed.
    const forgetful = new Billing(f.db, f.dev.stripe, f.time, f.random, {
      ...f.config,
      prices: { monthly: 'price_dev_monthly_v2' },
    });
    await expect(forgetful.reconcile('alice')).rejects.toThrow('mismatch');
  },
);

billingTest(
  'the browser chooses only a configured plan name, never a price',
  async ({ f }) => {
    for (const plan of [
      'price_dev_monthly',
      '__proto__',
      'constructor',
      'lifetime',
    ]) {
      const error = await f.start(plan).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BillingError);
      expect(error).toMatchObject({ status: 400, message: 'Unknown plan.' });
    }
    const lying = new Billing(f.db, f.dev.stripe, f.time, f.random, {
      ...f.config,
      prices: {
        monthly: { recognized: ['price_dev_monthly'], offer: () => 'price_x' },
      },
    });
    await expect(
      lying.checkout('alice', 'alice@example.test', 'monthly'),
    ).rejects.toThrow('does not recognize');
    expect(f.dev.requests).toEqual([]);
    const build = (prices: BillingConfig['prices']) =>
      new Billing(f.db, f.dev.stripe, f.time, f.random, {
        ...f.config,
        prices,
      });
    expect(() => build({})).toThrow('at least one plan');
    expect(() => build({ 'a plan': 'price_a' })).toThrow('Plan names');
    expect(() => build({ monthly: '' })).toThrow('empty Stripe price');
    expect(() => build({ monthly: 'price_a', yearly: 'price_a' })).toThrow(
      'exactly one plan',
    );
    expect(() =>
      build({ founding: { recognized: [], offer: () => 'price_a' } }),
    ).toThrow('needs a Stripe price');
  },
);

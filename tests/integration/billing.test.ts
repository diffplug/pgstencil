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
  purchaseStanding,
  STRIPE_API_VERSION,
  SUBSCRIBED,
  type BillingConfig,
  type BillingDB,
} from '../../packages/stripe/src/index.ts';
import { appMigrations } from '../../examples/login/src/migrations.ts';
import {
  createStripeDev,
  type StripeDevOptions,
} from '../../packages/stripe/src/testing.ts';
import { stableJson } from '../../packages/pgstencil/src/snapshots.ts';
import {
  queryDatabase,
  withClient,
} from '../../packages/pgstencil/src/postgres.ts';

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
  'an owner without an email checks out with Checkout collecting it',
  async ({ f }) => {
    const checkout = await f.billing.checkout('alice', null, 'monthly');
    const created = f.dev.requests.find(
      (r) => r.method === 'POST' && r.path === '/v1/customers',
    )!;
    // No email is sent, so Stripe's hosted page asks the buyer for one.
    expect(created.body).toEqual({ 'metadata[pgstencil_owner]': 'alice' });
    expect(
      (
        await f.billing.db
          .selectFrom('accounts')
          .select('email')
          .executeTakeFirstOrThrow()
      ).email,
    ).toBeNull();
    const session = [...f.dev.checkouts.values()].find(
      (s) => s.url === checkout.url,
    )!;
    f.dev.completeCheckout(session.id);
    await f.deliver();
    expect((await f.billing.status('alice')).access).toBe(true);
    await expect(f.billing.account('bob', '')).rejects.toThrow(
      'an email or null',
    );
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

test('automatic tax: Checkout calculates tax and saves the address it collects; not with Managed Payments', async ({
  onTestFinished,
}) => {
  const f = await fixture({ config: () => ({ automaticTax: true }) });
  onTestFinished(() => f.close());
  const { session } = await f.start();
  const creation = f.dev.requests.find(
    (r) => r.path === '/v1/checkout/sessions',
  )!.body;
  expect(creation).toMatchObject({
    'automatic_tax[enabled]': 'true',
    'customer_update[address]': 'auto',
    payment_method_collection: 'always',
    'subscription_data[trial_period_days]': '14',
  });
  expect(creation['managed_payments[enabled]']).toBeUndefined();
  expect(session.automatic_tax.enabled).toBe(true);
  f.dev.completeCheckout(session.id);
  await f.deliver();
  expect((await f.billing.status('alice')).access).toBe(true);
  for (const config of [
    { automaticTax: true, managedPayments: true },
    { automaticTax: 'yes' as unknown as boolean },
  ])
    expect(
      () =>
        new Billing(f.db, f.dev.stripe, f.time, f.random, {
          ...f.config,
          ...config,
        }),
    ).toThrow(config.managedPayments ? 'Managed Payments' : 'automaticTax');
});

billingTest(
  'a checkout ref is validated, kept across retries, and read back from the completion event',
  async ({ f }) => {
    for (const ref of ['Settings', '', 'a'.repeat(41), 'a b', 'a_b', 'é'])
      await expect(
        f.billing.checkout('alice', 'alice@example.test', 'monthly', { ref }),
      ).rejects.toMatchObject({ status: 400 });
    expect(f.dev.requests).toEqual([]);
    // The first response is lost; the retry sends the stored ref, not its own.
    f.dev.failNext('/v1/checkout/sessions', true);
    await expect(
      f.billing.checkout('alice', 'alice@example.test', 'monthly', {
        ref: 'settings-voice',
      }),
    ).rejects.toThrow();
    const checkout = await f.billing.checkout(
      'alice',
      'alice@example.test',
      'monthly',
      { ref: 'upsell:push' },
    );
    const creations = f.dev.requests.filter(
      (r) => r.path === '/v1/checkout/sessions',
    );
    expect(creations).toHaveLength(2);
    expect(creations[1]!.body).toEqual(creations[0]!.body);
    expect(creations[0]!.body).toMatchObject({
      'metadata[pgstencil_operation]': checkout.id,
      'metadata[pgstencil_ref]': 'settings-voice',
      'subscription_data[metadata][pgstencil_ref]': 'settings-voice',
    });
    const session = [...f.dev.checkouts.values()].find(
      (s) => s.url === checkout.url,
    )!;
    f.dev.completeCheckout(session.id);
    const completed: unknown[] = [];
    while (f.dev.events.length) {
      const { body, signature } = f.dev.signed(f.dev.events.shift()!);
      await f.billing.webhook(body, signature, async (event, trx) => {
        completed.push(await f.billing.completedCheckout(event, trx));
      });
    }
    expect(completed).toEqual([
      {
        operation: checkout.id,
        ownerId: 'alice',
        plan: 'monthly',
        priceId: f.dev.prices.monthly,
        ref: 'settings-voice',
      },
      null,
    ]);
    // Without a ref, Checkout carries no ref key and completion reports null.
    const bob = await f.start('monthly', 'bob');
    const body = f.dev.requests.at(-1)!.body;
    expect(
      Object.keys(body).filter((key) => key.includes('pgstencil_ref')),
    ).toEqual([]);
    f.dev.completeCheckout(bob.session.id);
    const event = f.dev.events.find(
      (e) => e.type === 'checkout.session.completed',
    )!;
    expect((await f.billing.completedCheckout(event))?.ref).toBeNull();
  },
);

billingTest(
  'the exported plan and purchase rules agree with status and purchaseCounts',
  async ({ f }) => {
    expect(f.billing.planOf(f.dev.prices.yearly)).toBe('yearly');
    expect(f.billing.planOf('price_retired')).toBeNull();
    expect(f.billing.planOf(null)).toBeNull();
    const day = 86_400_000;
    const at = (days: number) => new Date(f.time.now().getTime() + days * day);
    const cases = {
      open: ['active', at(0), null, null],
      unpaid: ['incomplete', at(0), null, null],
      gone: ['missing', at(0), at(40), null],
      trialOnly: ['canceled', at(0), at(14), at(14)],
      refundedAfterTrial: ['canceled', at(0), at(15), at(14)],
      paidAfterTrial: ['canceled', at(0), at(45), at(14)],
      refunded: ['canceled', at(0), at(30 - 1 / 86_400_000), null],
      atWindow: ['canceled', at(0), at(30), null],
      legacy: ['canceled', null, at(1), null],
    } as const;
    const rows = Object.entries(cases).map(
      ([id, [status, started_at, ended_at, trial_end]]) => ({
        id,
        owner_id: 'alice',
        price_id: `price_${id}`,
        status,
        started_at,
        ended_at,
        trial_end,
        period_end: at(30),
        cancel_at_period_end: false,
        updated_at: at(0),
      }),
    );
    await f.billing.account('alice', 'alice@example.test');
    await f.billing.db.insertInto('subscriptions').values(rows).execute();
    const standings = Object.fromEntries(
      rows.map((row) => [row.id, purchaseStanding(row, { refundDays: 30 })]),
    );
    expect(standings).toEqual({
      open: 'purchased',
      unpaid: 'unpurchased',
      gone: 'unpurchased',
      trialOnly: 'ended-in-trial',
      refundedAfterTrial: 'refund-window',
      paidAfterTrial: 'purchased',
      refunded: 'refund-window',
      atWindow: 'purchased',
      legacy: 'purchased',
    });
    const counts = await f.billing.purchaseCounts(
      rows.map((row) => row.price_id),
      { refundDays: 30 },
    );
    expect(counts).toEqual(
      Object.fromEntries(
        rows.map((row) => [
          row.price_id,
          standings[row.id] === 'purchased' ? 1 : 0,
        ]),
      ),
    );
    // Several windows in one query agree with one window at a time.
    const windows = [0, 30, 15, 45];
    const prices = rows.map((row) => row.price_id);
    const several = await f.billing.purchaseCounts(prices, {
      refundDays: windows,
    });
    expect(several).toEqual(
      await Promise.all(
        windows.map((refundDays) =>
          f.billing.purchaseCounts(prices, { refundDays }),
        ),
      ),
    );
    for (const [i, refundDays] of windows.entries())
      expect(several[i]).toEqual(
        Object.fromEntries(
          rows.map((row) => [
            row.price_id,
            purchaseStanding(row, { refundDays }) === 'purchased' ? 1 : 0,
          ]),
        ),
      );
    expect(new Set(several.map((c) => JSON.stringify(c))).size).toBe(3);
    expect(await f.billing.purchaseCounts(prices, { refundDays: [] })).toEqual(
      [],
    );
    await expect(
      f.billing.purchaseCounts(prices, { refundDays: [30, -1] }),
    ).rejects.toThrow('refundDays');
    // A webhook's Stripe subscription reads the same way as its synchronized row.
    const { session } = await f.start('monthly', 'bob');
    const sub = f.dev.completeCheckout(session.id);
    await f.deliver();
    f.time.advanceDays(3);
    f.dev.transition(sub.id, 'cancel');
    const canceled = f.dev.events.at(-1)!.data.object as typeof sub;
    await f.deliver();
    const row = (await f.billing.status('bob')).subscription!;
    expect(purchaseStanding(canceled, { refundDays: 30 })).toBe(
      'ended-in-trial',
    );
    expect(purchaseStanding(row, { refundDays: 30 })).toBe('ended-in-trial');
    expect(() => purchaseStanding(row, { refundDays: 1.5 })).toThrow(
      'refundDays',
    );
  },
);

billingTest(
  'owner_access is the access rule status() applies, for application SQL under a read-only grant',
  async ({ f }) => {
    expect(SUBSCRIBED).toEqual([
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'paused',
      'incomplete',
    ]);
    const statuses = [
      ...SUBSCRIBED,
      'canceled',
      'incomplete_expired',
      'missing',
    ];
    const day = 86_400_000;
    const at = (days: number) => new Date(f.time.now().getTime() + days * day);
    const row = (
      id: string,
      owner: string,
      status: string,
      period: number,
      trial: number | null,
    ) => ({
      id,
      owner_id: owner,
      price_id: f.dev.prices.monthly,
      status,
      started_at: at(-1),
      ended_at: null,
      period_end: at(period),
      trial_end: trial === null ? null : at(trial),
      cancel_at_period_end: false,
      updated_at: at(0),
    });
    // Alone, each status with its period and trial ending before, at and
    // after the clock; beside a valid `active` one, each other status.
    const expected = new Map<string, boolean>();
    const rows = [];
    for (const status of statuses) {
      for (const [name, period, trial] of [
        ['past', -1, -1],
        ['now', 0, 0],
        ['period', 1, -1],
        ['trial', -1, 1],
        ['both', 1, 1],
        ['notrial', 1, null],
      ] as const) {
        const owner = `${status}-${name}`;
        rows.push(row(`sub_${owner}`, owner, status, period, trial));
        expected.set(
          owner,
          (status === 'active' && period > 0) ||
            (status === 'trialing' && trial !== null && trial > 0),
        );
      }
      const owner = `pair-${status}`;
      rows.push(row(`sub_${owner}_a`, owner, 'active', 1, null));
      rows.push(row(`sub_${owner}_b`, owner, status, 1, 1));
      expected.set(owner, !SUBSCRIBED.includes(status));
    }
    await f.billing.db
      .insertInto('accounts')
      .values(
        [...expected.keys()].map((owner) => ({
          owner_id: owner,
          email: null,
          created_at: at(0),
        })),
      )
      .execute();
    await f.billing.db.insertInto('subscriptions').values(rows).execute();
    const reader = `SELECT owner_id AS owner FROM pgstencil_billing.owner_access
      WHERE access_until > $1`;
    const granted = new Set(
      (
        await queryDatabase<{ owner: string }>(f.database.url, reader, [
          f.time.now(),
        ])
      ).map((r) => r.owner),
    );
    for (const [owner, access] of expected) {
      expect([owner, (await f.billing.status(owner)).access]).toEqual([
        owner,
        access,
      ]);
      expect([owner, granted.has(owner)]).toEqual([owner, access]);
    }
    expect(granted.size).toBeGreaterThan(3);
    // A role granted only the view reads it, never the table beneath it.
    // Roles are cluster-wide, so this one lives only inside a transaction.
    const role = `pgstencil_reader_${f.random.bytes(6).toString('hex')}`;
    await withClient(f.database.url, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`CREATE ROLE ${role}`);
        await client.query(
          `GRANT USAGE ON SCHEMA pgstencil_billing TO ${role}`,
        );
        await client.query(
          `GRANT SELECT ON pgstencil_billing.owner_access TO ${role}`,
        );
        await client.query(`SET LOCAL ROLE ${role}`);
        const read = await client.query(reader, [f.time.now()]);
        expect(read.rows.length).toBe(granted.size);
        await expect(
          client.query('SELECT 1 FROM pgstencil_billing.subscriptions'),
        ).rejects.toThrow('permission denied');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  },
);

billingTest(
  'reconcileStale repairs a bounded batch of owners whose renewal webhook went missing',
  async ({ f }) => {
    const subs: Record<string, string> = {};
    for (const owner of ['alice', 'bob', 'carol']) {
      const { session } = await f.start('monthly', owner);
      subs[owner] = f.dev.completeCheckout(session.id).id;
    }
    await f.deliver();
    f.time.advanceDays(15);
    const dave = await f.start('monthly', 'dave');
    f.dev.completeCheckout(dave.session.id);
    await f.deliver();
    // Stripe converts two trials, but their webhooks never arrive; carol's
    // has not been moved on yet.
    f.dev.transition(subs.alice!, 'renew');
    f.dev.transition(subs.bob!, 'renew');
    f.dev.events.length = 0;
    const access = async () =>
      Object.fromEntries(
        await Promise.all(
          ['alice', 'bob', 'carol', 'dave'].map(async (owner) => [
            owner,
            (await f.billing.status(owner)).access,
          ]),
        ),
      );
    expect(await access()).toEqual({
      alice: false,
      bob: false,
      carol: false,
      dave: true,
    });
    const first = await f.billing.reconcileStale({ limit: 2 });
    expect(first.failed).toEqual([]);
    expect(first.reconciled).toHaveLength(2);
    expect(
      first.reconciled.every((owner) =>
        ['alice', 'bob', 'carol'].includes(owner),
      ),
    ).toBe(true);
    f.dev.failNext('/v1/subscriptions');
    const second = await f.billing.reconcileStale({ limit: 10 });
    // The remaining stale owners: carol, and whichever of alice and bob waited.
    expect(second.reconciled.length + second.failed.length).toBe(
      first.reconciled.includes('carol') ? 2 : 1,
    );
    expect(second.failed).toHaveLength(1);
    await f.billing.reconcileStale({ limit: 10 });
    expect(await access()).toEqual({
      alice: true,
      bob: true,
      carol: false,
      dave: true,
    });
    // Only carol, whose trial Stripe has not converted, is still stale.
    expect((await f.billing.reconcileStale({ limit: 10 })).reconciled).toEqual([
      'carol',
    ]);
    await expect(f.billing.reconcileStale({ limit: 0 })).rejects.toThrow(
      'limit',
    );
  },
);

foundingTest(
  'checkout charges only a Price the application expects, and replace gives way to another plan',
  async ({ f }) => {
    const session = (url: string) =>
      [...f.dev.checkouts.values()].find((s) => s.url === url)!;
    const shown = (price: string) => (priceId: string) => priceId === price;
    const erin = await f.billing.checkout(
      'erin',
      'erin@example.test',
      'founding',
      {
        expectPrice: shown(ladder[0]!),
      },
    );
    expect(erin.priceId).toBe(ladder[0]);
    // Refused before any Stripe write, for an owner billing never knew.
    const before = f.dev.requests.length;
    const refused = await f.billing
      .checkout('zed', 'zed@example.test', 'founding', {
        expectPrice: shown(ladder[1]!),
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BillingError);
    expect(refused).toMatchObject({ status: 409, code: 'unexpected-price' });
    expect(f.dev.requests.length).toBe(before);
    // Accepted at first but refused under the owner's lock, as when a
    // concurrent request changed it: no Checkout Session is created.
    let calls = 0;
    await expect(
      f.billing.checkout('zed', 'zed@example.test', 'founding', {
        expectPrice: () => calls++ === 0,
      }),
    ).rejects.toMatchObject({ code: 'unexpected-price' });
    expect(calls).toBe(2);
    expect(
      f.dev.requests
        .slice(before)
        .filter((r) => r.path === '/v1/checkout/sessions'),
    ).toEqual([]);
    for (const owner of ['alice', 'bob']) {
      const { session } = await f.start('founding', owner);
      f.dev.completeCheckout(session.id);
    }
    await f.deliver();
    expect(await f.billing.offeredPrice('founding')).toBe(ladder[1]);
    // A plain retry reuses erin's open checkout at the Price it opened with.
    expect(
      await f.billing.checkout('erin', 'erin@example.test', 'founding'),
    ).toEqual(erin);
    // Shown the next cohort's Price, she is refused, and the stale checkout
    // gives way, so asking again opens at the Price she was shown.
    await expect(
      f.billing.checkout('erin', 'erin@example.test', 'founding', {
        expectPrice: shown(ladder[1]!),
      }),
    ).rejects.toMatchObject({ code: 'unexpected-price' });
    expect(session(erin.url).status).toBe('expired');
    const next = await f.billing.checkout(
      'erin',
      'erin@example.test',
      'founding',
      { expectPrice: shown(ladder[1]!) },
    );
    expect(next).toMatchObject({ priceId: ladder[1] });
    expect(next.id).not.toBe(erin.id);
    // Another plan is refused while a checkout is open, unless it replaces it.
    await expect(
      f.billing.checkout('erin', 'erin@example.test', 'monthly'),
    ).rejects.toThrow('Cancel the open checkout');
    const monthly = await f.billing.checkout(
      'erin',
      'erin@example.test',
      'monthly',
      { replace: true },
    );
    expect(monthly.priceId).toBe(f.dev.prices.monthly);
    expect(session(next.url).status).toBe('expired');
    expect(session(monthly.url).status).toBe('open');
  },
);

billingTest(
  'end() cancels at once without proration and records its reason, which the deleted webhook reads',
  async ({ f }) => {
    const contexts: unknown[] = [];
    const deliver = async () => {
      while (f.dev.events.length) {
        const { body, signature } = f.dev.signed(f.dev.events.shift()!);
        await f.billing.webhook(
          body,
          signature,
          async (event, _trx, context) => {
            contexts.push([event.type, context]);
          },
        );
      }
    };
    const { session } = await f.start();
    const sub = f.dev.completeCheckout(session.id);
    await deliver();
    expect(contexts).toEqual([
      ['checkout.session.completed', { ownerId: 'alice', subscription: null }],
      [
        'customer.subscription.created',
        {
          ownerId: 'alice',
          subscription: expect.objectContaining({
            id: sub.id,
            status: 'trialing',
            end_reason: null,
          }),
        },
      ],
    ]);
    contexts.length = 0;
    await expect(
      f.billing.end('mallory', sub.id, { reason: 'refund' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.billing.end('alice', 'sub_unknown', { reason: 'refund' }),
    ).rejects.toMatchObject({ status: 404 });
    for (const reason of ['', 'Refund', 'a'.repeat(41), 'a b'])
      await expect(f.billing.end('alice', sub.id, { reason })).rejects.toThrow(
        'end reason',
      );
    expect(f.dev.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(await f.billing.end('alice', sub.id, { reason: 'refund' })).toBe(
      true,
    );
    expect(f.dev.requests.filter((r) => r.method === 'DELETE')).toEqual([
      {
        method: 'DELETE',
        path: `/v1/subscriptions/${sub.id}`,
        body: { prorate: 'false', invoice_now: 'false' },
      },
    ]);
    expect(await f.billing.status('alice')).toMatchObject({
      access: false,
      subscription: { status: 'canceled', end_reason: 'refund' },
    });
    await deliver();
    expect(contexts).toEqual([
      [
        'customer.subscription.deleted',
        {
          ownerId: 'alice',
          subscription: expect.objectContaining({
            id: sub.id,
            status: 'canceled',
            end_reason: 'refund',
          }),
        },
      ],
    ]);
    // Ended already: nothing is sent and the first reason stands.
    expect(await f.billing.end('alice', sub.id, { reason: 'closure' })).toBe(
      false,
    );
    expect(f.dev.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    expect((await f.billing.status('alice')).subscription?.end_reason).toBe(
      'refund',
    );
    // A subscription pgstencil did not end carries no reason.
    contexts.length = 0;
    const bob = await f.start('monthly', 'bob');
    const bobSub = f.dev.completeCheckout(bob.session.id);
    f.dev.transition(bobSub.id, 'cancel');
    await deliver();
    expect(contexts.at(-1)).toEqual([
      'customer.subscription.deleted',
      {
        ownerId: 'bob',
        subscription: expect.objectContaining({
          status: 'canceled',
          end_reason: null,
        }),
      },
    ]);
  },
);

billingTest(
  'owner and customer lookups, dispute owners through their charge, and an already-verified event',
  async ({ f }) => {
    expect(await f.billing.customerOf('alice')).toBeNull();
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    await f.deliver();
    const customer = (await f.billing.customerOf('alice'))!;
    expect(customer).toMatch(/^cus_/);
    expect(await f.billing.ownerOfCustomer(customer)).toBe('alice');
    expect(await f.billing.ownerOfCustomer({ id: customer })).toBe('alice');
    expect(await f.billing.ownerOfCustomer('cus_stranger')).toBeNull();
    expect(await f.billing.ownerOfCustomer(null)).toBeNull();
    const ours = f.dev.dispute(customer);
    f.dev.dispute('cus_stranger');
    const owners: (string | null)[] = [];
    const apply = async (
      _event: unknown,
      _trx: unknown,
      context: { ownerId: string | null },
    ) => {
      owners.push(context.ownerId);
    };
    // Verified once to read it first, then processed without a second check.
    while (f.dev.events.length) {
      const { body, signature } = f.dev.signed(f.dev.events.shift()!);
      const event = await f.billing.verifyWebhook(body, signature);
      await f.billing.webhook(event, apply);
    }
    expect(owners).toEqual(['alice', null]);
    expect(
      f.dev.requests.filter((r) => r.path.startsWith('/v1/charges/')),
    ).toHaveLength(2);
    // A parsed body was never verified, so it is refused.
    const parsed = JSON.parse(f.dev.signed(ours).body);
    await expect(f.billing.webhook(parsed, apply)).rejects.toThrow(
      'verifyWebhook',
    );
    expect(owners).toHaveLength(2);
  },
);

import { test, expect } from 'vitest';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { connectDatabase } from '../../packages/pgstencil/src/database.ts';
import {
  Billing,
  STRIPE_API_VERSION,
  type BillingDB,
} from '../../packages/stripe/src/index.ts';
import { appMigrations } from '../../examples/login/src/migrations.ts';
import { createStripeDev } from '../../packages/stripe/src/testing.ts';
import { stableJson } from '../../packages/pgstencil/src/snapshots.ts';

async function fixture() {
  const context = await createTestContext({
    migrations: appMigrations,
  });
  const dev = await createStripeDev(context.time, context.random);
  const db = connectDatabase<BillingDB>(context.database.url);
  const billing = new Billing(db, dev.stripe, context.time, context.random, {
    prices: dev.prices,
    trialDays: 14,
    webhookSecret: dev.webhookSecret,
    live: false,
    origin: 'https://example.test',
  });
  return {
    ...context,
    dev,
    billing,
    async start(plan: 'monthly' | 'yearly' = 'monthly', owner = 'alice') {
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

/**
 * Pins the `SECURITY.md` billing rules that `billing.test.ts` does not already
 * pin. Every test drives the real `Billing` against real Postgres and the
 * StripeDev simulator through the real Stripe SDK.
 */
import { test, expect } from 'vitest';
import {
  withDiagnostics,
  type DiagnosticRecord,
} from '../../packages/pgstencil/src/diagnostics.ts';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { connectDatabase } from '../../packages/pgstencil/src/database.ts';
import {
  Billing,
  BillingError,
  Stripe,
  STRIPE_API_VERSION,
  type BillingConfig,
  type BillingDB,
} from '../../packages/stripe/src/index.ts';
import { billingMigrations } from '../../packages/stripe/src/migrations.ts';
import { createStripeDev } from '../../packages/stripe/src/testing.ts';

async function fixture(config: Partial<BillingConfig> = {}) {
  const context = await createTestContext({ migrations: billingMigrations });
  const dev = await createStripeDev(context.time, context.random);
  const db = connectDatabase<BillingDB>(context.database.url);
  const base: BillingConfig = {
    prices: dev.prices,
    trialDays: 14,
    webhookSecret: dev.webhookSecret,
    live: false,
    origin: 'https://example.test',
    ...config,
  };
  /** Another `Billing` over the same database, optionally on another Stripe client. */
  const make = (
    overrides: Partial<BillingConfig> = {},
    stripe: Stripe = dev.stripe,
  ) =>
    new Billing(db, stripe, context.time, context.random, {
      ...base,
      ...overrides,
    });
  const billing = make();
  return {
    ...context,
    dev,
    db,
    billing,
    make,
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
    /** A signed-able event around `object`, as Stripe would send it. */
    event(id: string, type: string, object: unknown, created?: number) {
      return {
        id,
        object: 'event',
        api_version: STRIPE_API_VERSION,
        created: created ?? Math.floor(context.time.now().getTime() / 1000),
        livemode: false,
        type,
        data: { object },
        pending_webhooks: 1,
        request: null,
      } as unknown as Stripe.Event;
    },
    requests(method: string, path: string) {
      return dev.requests.filter((r) => r.method === method && r.path === path);
    },
    async close() {
      await db.destroy();
      await dev.close();
      await context.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const billingTest = test.extend<{ f: Fixture }>({
  f: async ({}, use) => {
    const f = await fixture();
    try {
      await use(f);
    } finally {
      await f.close();
    }
  },
});

/** The fields of a listed subscription that `synchronize` checks. */
interface Listed {
  customer: unknown;
  livemode: boolean;
  metadata: Record<string, string>;
  items: { data: { id: string; quantity: number; price: { id: string } }[] };
}
/**
 * A Stripe client on StripeDev whose subscription lists pass through `tamper`
 * on the way back, as a Stripe account changed outside pgstencil would answer.
 * It rewrites responses rather than StripeDev's state, so it holds however
 * `synchronize` pages through the list.
 */
function tamperedStripe(origin: string, tamper: (sub: Listed) => void) {
  const { hostname, port } = new URL(origin);
  return new Stripe('sk_test_pgstencil_local_only', {
    host: hostname,
    port: Number(port),
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 5000,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const response = await fetch(input, init);
      if (
        init?.method !== 'GET' ||
        new URL(String(input)).pathname !== '/v1/subscriptions'
      )
        return response;
      const list = (await response.json()) as { data: Listed[] };
      list.data.forEach(tamper);
      return Response.json(list, { status: response.status });
    }),
  });
}

billingTest(
  'webhook(event) takes only an event this Billing verified, and a rejected delivery reaches neither the ledger nor apply',
  async ({ f }) => {
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    const event = f.dev.events[0]!;
    const signed = f.dev.signed(event);
    let calls = 0;
    const apply = async () => {
      calls++;
    };
    // The signature verifies against the injected clock, years behind the host's.
    expect(f.time.now().getTime()).toBeLessThan(Date.now() - 86_400_000);
    const verified = await f.billing.verifyWebhook(
      signed.body,
      signed.signature,
    );
    // Another instance, even with the same secret, never verified this object.
    await expect(f.make().webhook(verified, apply)).rejects.toThrow(
      'verifyWebhook',
    );
    // Nor is a copy the object verifyWebhook returned.
    await expect(
      f.billing.webhook(structuredClone(verified), apply),
    ).rejects.toThrow('verifyWebhook');
    // Another secret, and a re-serialized body, fail the signature.
    const attacker = f.dev.stripe.webhooks.generateTestHeaderString({
      payload: signed.body,
      secret: 'whsec_not_the_endpoint_secret',
      timestamp: Math.floor(f.time.now().getTime() / 1000),
    });
    await expect(
      f.billing.webhook(signed.body, attacker, apply),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.billing.webhook(
        JSON.stringify(JSON.parse(signed.body), null, 2),
        signed.signature,
        apply,
      ),
    ).rejects.toMatchObject({ status: 400 });
    // Correctly signed, but not this endpoint's mode, version or account.
    for (const invalid of [
      { ...event, livemode: true },
      { ...event, api_version: '2000-01-01' },
      { ...event, account: 'acct_other' },
    ]) {
      const s = f.dev.signed(invalid as typeof event);
      const error = await f.billing
        .verifyWebhook(s.body, s.signature)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BillingError);
      expect(error).toMatchObject({ status: 400 });
    }
    expect(calls).toBe(0);
    expect(
      await f.billing.db.selectFrom('events').selectAll().execute(),
    ).toEqual([]);
    expect((await f.billing.status('alice')).access).toBe(false);
    // The verified object itself is processed, once.
    await f.billing.webhook(verified, apply);
    await f.billing.webhook(verified, apply);
    expect(calls).toBe(1);
    expect((await f.billing.status('alice')).access).toBe(true);
  },
);

billingTest(
  'concurrent deliveries of one event run apply once and record one attempt',
  async ({ f }) => {
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    const signed = f.dev.signed(f.dev.events[0]!);
    let calls = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        f.billing.webhook(signed.body, signed.signature, async () => {
          calls++;
        }),
      ),
    );
    expect(calls).toBe(1);
    expect(
      await f.billing.db
        .selectFrom('events')
        .select(['attempts', 'failed'])
        .execute(),
    ).toEqual([{ attempts: 1, failed: false }]);
  },
);

billingTest(
  'event content never grants access: the resync reads Stripe, and context and completions are matched to the owner',
  async ({ f }) => {
    const alice = await f.start();
    const sub = f.dev.completeCheckout(alice.session.id);
    const bob = await f.start('monthly', 'bob');
    const bobSub = f.dev.completeCheckout(bob.session.id);
    await f.deliver();
    f.dev.transition(sub.id, 'cancel');
    await f.deliver();
    expect((await f.billing.status('alice')).access).toBe(false);
    const aliceCustomer = (await f.billing.customerOf('alice'))!;
    const now = Math.floor(f.time.now().getTime() / 1000);
    const contexts: unknown[] = [];
    const completions: unknown[] = [];
    const deliver = async (event: Stripe.Event) => {
      const { body, signature } = f.dev.signed(event);
      await f.billing.webhook(body, signature, async (e, trx, context) => {
        contexts.push(context);
        completions.push(await f.billing.completedCheckout(e, trx));
      });
    };
    // A correctly signed event, newer than the cancellation, whose body still
    // claims an active subscription a year long.
    const claimed = structuredClone(sub) as unknown as Record<string, unknown> &
      Listed;
    Object.assign(claimed, { status: 'active', ended_at: null });
    Object.assign(claimed.items.data[0]!, { current_period_end: now + 31e6 });
    await deliver(
      f.event(
        'evt_claimsactive',
        'customer.subscription.updated',
        claimed,
        now + 3600,
      ),
    );
    expect((await f.billing.status('alice')).access).toBe(false);
    expect(contexts.at(-1)).toEqual({
      ownerId: 'alice',
      subscription: expect.objectContaining({ id: sub.id, status: 'canceled' }),
    });
    // An event naming alice's customer and bob's subscription reads back no
    // row, and leaves bob's row his.
    const crossed = { ...structuredClone(bobSub), customer: aliceCustomer };
    await deliver(
      f.event('evt_crossed', 'customer.subscription.updated', crossed),
    );
    expect(contexts.at(-1)).toEqual({ ownerId: 'alice', subscription: null });
    expect((await f.billing.status('bob')).subscription).toMatchObject({
      id: bobSub.id,
      owner_id: 'bob',
    });
    expect((await f.billing.status('alice')).access).toBe(false);
    // A customer pgstencil did not create resyncs nobody, whatever owner its
    // metadata names.
    const listsBefore = f.requests('GET', '/v1/subscriptions').length;
    const stranger = {
      ...claimed,
      id: 'sub_stranger',
      customer: 'cus_stranger',
      metadata: { pgstencil_owner: 'alice' },
    };
    await deliver(
      f.event('evt_stranger', 'customer.subscription.created', stranger),
    );
    expect(contexts.at(-1)).toEqual({ ownerId: null, subscription: null });
    expect(f.requests('GET', '/v1/subscriptions')).toHaveLength(listsBefore);
    expect(
      await f.billing.db
        .selectFrom('subscriptions')
        .select('id')
        .where('id', '=', 'sub_stranger')
        .execute(),
    ).toEqual([]);
    // A completion naming alice's operation on another session is not hers.
    const forged = { ...structuredClone(alice.session), id: 'cs_forged' };
    expect(forged.metadata?.pgstencil_operation).toBe(alice.checkout.id);
    await deliver(
      f.event('evt_forgedcompletion', 'checkout.session.completed', forged),
    );
    expect(completions).toEqual([null, null, null, null]);
    expect((await f.billing.status('alice')).access).toBe(false);
  },
);

billingTest(
  "a subscription counts only with the owner's metadata, its customer, one item, a recognized price, quantity 1 and the configured livemode",
  async ({ f }) => {
    const { session } = await f.start();
    const sub = f.dev.completeCheckout(session.id);
    await f.deliver();
    const row = () =>
      f.billing.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('id', '=', sub.id)
        .executeTakeFirstOrThrow();
    const synced = await row();
    expect(synced.status).toBe('trialing');
    let tamper: ((s: Listed) => void) | null = null;
    const tampered = f.make(
      {},
      tamperedStripe(f.dev.origin, (s) => tamper?.(s)),
    );
    const mismatches: Record<string, (s: Listed) => void> = {
      customer: (s) => {
        s.customer = 'cus_someone_else';
      },
      'two items': (s) => {
        s.items.data.push({ ...s.items.data[0]!, id: 'si_second' });
      },
      'no item': (s) => {
        s.items.data = [];
      },
      'unrecognized price': (s) => {
        s.items.data[0]!.price.id = 'price_not_configured';
      },
      'quantity 2': (s) => {
        s.items.data[0]!.quantity = 2;
      },
      livemode: (s) => {
        s.livemode = true;
      },
    };
    for (const [name, change] of Object.entries(mismatches)) {
      tamper = change;
      await expect(tampered.reconcile('alice'), name).rejects.toThrow(
        'mismatch',
      );
      // A webhook for the owner fails the same way, writes nothing, and stays retryable.
      const id = `evt_mismatch${name.replace(/\W/g, '')}`;
      const { body, signature } = f.dev.signed(
        f.event(id, 'customer.subscription.updated', sub),
      );
      await expect(tampered.webhook(body, signature), name).rejects.toThrow(
        'mismatch',
      );
      expect(await row(), name).toEqual(synced);
      expect(
        await f.billing.db
          .selectFrom('events')
          .select(['failed', 'processed_at'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
        name,
      ).toEqual({ failed: true, processed_at: null });
    }
    // Another owner's metadata, or none, is not this owner's subscription:
    // its row stops counting, and the trial it used stays used.
    for (const change of [
      (s: Listed) => {
        s.metadata.pgstencil_owner = 'mallory';
      },
      (s: Listed) => {
        delete s.metadata.pgstencil_owner;
      },
    ]) {
      tamper = change;
      await tampered.reconcile('alice');
      expect((await row()).status).toBe('missing');
      expect(await tampered.status('alice')).toMatchObject({
        access: false,
        trialEligible: false,
      });
    }
    await tampered.checkout('alice', 'alice@example.test', 'yearly');
    const reopened = f.requests('POST', '/v1/checkout/sessions').at(-1)!.body;
    expect(reopened['line_items[0][price]']).toBe(f.dev.prices.yearly);
    expect(reopened['subscription_data[trial_period_days]']).toBeUndefined();
    // Once Stripe answers consistently again, the same event applies.
    tamper = null;
    const { body, signature } = f.dev.signed(
      f.event('evt_mismatchlivemode', 'customer.subscription.updated', sub),
    );
    await tampered.webhook(body, signature);
    expect((await row()).status).toBe('trialing');
    expect((await f.billing.status('alice')).access).toBe(true);
  },
);

billingTest(
  'racing checkouts open one Checkout Session per owner, and none opens beside a held subscription',
  async ({ f }) => {
    const race = () =>
      Promise.allSettled(
        ['monthly', 'yearly', 'monthly', 'yearly', 'yearly'].map((plan) =>
          f.billing.checkout('alice', 'alice@example.test', plan),
        ),
      );
    const first = await race();
    const opened = first.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value.id] : [],
    );
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened).size).toBe(1);
    for (const r of first)
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(BillingError);
        expect(r.reason.message).toContain('Cancel the open checkout');
      }
    // Racers reusing the one pending operation may each send its creation,
    // always under that operation's key, so Stripe creates one session.
    const keys = f.requests('POST', '/v1/checkout/sessions').map((r) => r.key);
    expect(new Set(keys)).toEqual(new Set(opened.slice(0, 1)));
    expect(f.dev.checkouts.size).toBe(1);
    expect(f.dev.customers.size).toBe(1);
    expect(
      await f.billing.db
        .selectFrom('checkouts')
        .select('id')
        .where('status', 'in', ['pending', 'open'])
        .execute(),
    ).toEqual([{ id: opened[0] }]);
    f.dev.completeCheckout([...f.dev.checkouts.keys()][0]!);
    await f.deliver();
    const second = await race();
    for (const r of second) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected')
        expect(r.reason.message).toContain('Manage billing');
    }
    expect(f.requests('POST', '/v1/checkout/sessions')).toHaveLength(
      keys.length,
    );
    expect(f.dev.checkouts.size).toBe(1);
  },
);

billingTest(
  'creation keys are committed before Stripe sees them, retries resend them, and an ambiguous Checkout past 23 hours fails closed',
  async ({ f }) => {
    f.dev.failNext('/v1/checkout/sessions', true);
    await expect(f.start()).rejects.toThrow();
    const pending = await f.billing.db
      .selectFrom('checkouts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(pending).toMatchObject({ status: 'pending', session_id: null });
    const account = await f.billing.db
      .selectFrom('accounts')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(f.requests('POST', '/v1/customers').map((r) => r.key)).toEqual([
      account.customer_key,
    ]);
    const { checkout } = await f.start();
    expect(checkout.id).toBe(pending.id);
    const creations = f.requests('POST', '/v1/checkout/sessions');
    expect(creations.map((r) => r.key)).toEqual([pending.id, pending.id]);
    expect(creations[1]!.body).toEqual(creations[0]!.body);
    expect(f.dev.checkouts.size).toBe(1);
    // Bob's response is lost too, and he returns a day later.
    f.dev.failNext('/v1/checkout/sessions', true);
    await expect(f.start('monthly', 'bob')).rejects.toThrow();
    f.time.advanceHours(23);
    await expect(f.start('monthly', 'bob')).rejects.toThrow(
      'Checkout creation needs reconciliation',
    );
    expect(f.requests('POST', '/v1/checkout/sessions')).toHaveLength(3);
    // Nothing else opens a chargeable Checkout for him in the meantime.
    await expect(f.start('yearly', 'bob')).rejects.toThrow(
      'Cancel the open checkout',
    );
    await expect(f.billing.cancelCheckout('bob')).rejects.toThrow(
      'still being created',
    );
    expect(f.requests('POST', '/v1/checkout/sessions')).toHaveLength(3);
  },
);

test('the server picks customer, price, quantity and return URLs, and the constructor refuses off-origin configuration', async ({
  onTestFinished,
}) => {
  const f = await fixture({
    returnPath: '/account/billing',
    portalConfiguration: 'bpc_pgstencil',
  });
  onTestFinished(() => f.close());
  const returnUrl = 'https://example.test/account/billing';
  expect(f.billing.returnUrl).toBe(returnUrl);
  expect(f.billing.redirectOrigins).toEqual([
    'https://checkout.stripe.com',
    'https://billing.stripe.com',
  ]);
  const { checkout } = await f.start('yearly');
  const customer = await f.billing.customerOf('alice');
  // Exactly these parameters: one line item, quantity 1, and no key a caller supplied.
  expect(f.requests('POST', '/v1/checkout/sessions')[0]!.body).toEqual({
    mode: 'subscription',
    customer,
    client_reference_id: 'alice',
    'line_items[0][price]': f.dev.prices.yearly,
    'line_items[0][quantity]': '1',
    payment_method_collection: 'always',
    'allowed_payment_method_types[0]': 'card',
    'subscription_data[metadata][pgstencil_owner]': 'alice',
    'subscription_data[metadata][pgstencil_operation]': checkout.id,
    'subscription_data[trial_period_days]': '14',
    'subscription_data[trial_settings][end_behavior][missing_payment_method]':
      'cancel',
    'metadata[pgstencil_operation]': checkout.id,
    success_url: `${returnUrl}?checkout=${checkout.id}`,
    cancel_url: returnUrl,
    expires_at: String(Math.floor(f.time.now().getTime() / 1000) + 3600),
  });
  await f.billing.portal('alice');
  expect(f.requests('POST', '/v1/billing_portal/sessions')[0]!.body).toEqual({
    customer,
    return_url: returnUrl,
    configuration: 'bpc_pgstencil',
  });
  const build = (config: Partial<BillingConfig>) => () => f.make(config);
  expect(build({ origin: 'https://example.test/' })).toThrow('origin only');
  expect(build({ origin: 'https://example.test/app' })).toThrow('origin only');
  expect(build({ returnPath: '//evil.example/billing' })).toThrow(
    'same-origin',
  );
  expect(build({ returnPath: 'https://evil.example/billing' })).toThrow(
    'same-origin',
  );
  expect(
    build({ redirectOrigins: ['https://checkout.stripe.com/c/pay'] }),
  ).toThrow('origins only');
  expect(build({ webhookSecret: '' })).toThrow('webhook secret');
});

billingTest(
  "confirmCheckout acts only on the calling owner's own subscription Checkout",
  async ({ f }) => {
    const alice = await f.start();
    await f.start('monthly', 'bob');
    for (const owner of ['bob', 'mallory'])
      await expect(
        f.billing.confirmCheckout(owner, alice.checkout.id),
      ).rejects.toMatchObject({ status: 404 });
    // The stored operation is alice's, but Stripe's session must be too.
    const session = alice.session as unknown as Record<string, unknown>;
    const bobCustomer = await f.billing.customerOf('bob');
    for (const [field, value] of [
      ['client_reference_id', 'bob'],
      ['customer', bobCustomer],
      ['mode', 'payment'],
    ] as const) {
      const original = session[field];
      session[field] = value;
      await expect(
        f.billing.confirmCheckout('alice', alice.checkout.id),
        field,
      ).rejects.toThrow('owner mismatch');
      session[field] = original;
    }
    // An open session confirms nothing; a completed one grants through the resync.
    await f.billing.confirmCheckout('alice', alice.checkout.id);
    expect((await f.billing.status('alice')).access).toBe(false);
    f.dev.completeCheckout(alice.session.id);
    await f.billing.confirmCheckout('alice', alice.checkout.id);
    expect((await f.billing.status('alice')).access).toBe(true);
    expect((await f.billing.status('bob')).access).toBe(false);
  },
);

billingTest(
  'webhook diagnostics name an event only once it verifies, and never carry a body, signature, secret or message',
  async ({ f }) => {
    const { session } = await f.start();
    f.dev.completeCheckout(session.id);
    const event = f.dev.events[0]!;
    const signed = f.dev.signed(event);
    const records: DiagnosticRecord[] = [];
    const observe = (run: () => Promise<void>) =>
      withDiagnostics(
        { sink: (record) => records.push(record), time: f.time },
        run,
      );
    const tampered = signed.body.replace('"alice"', '"mallory"');
    expect(tampered).not.toBe(signed.body);
    await expect(
      observe(() => f.billing.webhook(tampered, signed.signature)),
    ).rejects.toMatchObject({ status: 400 });
    const live = f.dev.signed({ ...event, livemode: true });
    await expect(
      observe(() => f.billing.webhook(live.body, live.signature)),
    ).rejects.toThrow('configuration');
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({
        event: 'billing.webhook.failed',
        stage: 'transport',
        reason: 'request_rejected',
      });
      expect(record).not.toHaveProperty('stripeEventId');
    }
    f.dev.failNext('/v1/subscriptions');
    await expect(
      observe(() =>
        f.billing.webhook(signed.body, signed.signature, async () => {}),
      ),
    ).rejects.toThrow();
    expect(records.slice(2)).toMatchObject([
      { event: 'billing.webhook.received', stripeEventId: event.id },
      {
        event: 'billing.webhook.failed',
        stage: 'database',
        stripeEventId: event.id,
      },
    ]);
    const text = JSON.stringify(records);
    for (const secret of [
      f.dev.webhookSecret,
      signed.signature,
      live.signature,
      session.id,
      (await f.billing.customerOf('alice'))!,
      'alice',
      'mallory',
      'No signatures found',
      'injected outage',
    ])
      expect(text).not.toContain(secret);
  },
);

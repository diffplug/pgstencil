import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { token, type Time, type RandomSource } from 'pgstencil';
import { Stripe, STRIPE_API_VERSION } from './index.ts';

/** Stateful, local Stripe substitute. Uses the real SDK and webhook signatures. */
export async function createStripeDev(
  time: Time,
  random: RandomSource,
  statePath?: string,
) {
  const customers = new Map<string, Record<string, unknown>>();
  const checkouts = new Map<string, Stripe.Checkout.Session>();
  const subscriptions = new Map<string, Stripe.Subscription>();
  const parameters = new Map<string, URLSearchParams>();
  const idempotency = new Map<string, { input: string; result: unknown }>();
  const requests: {
    method: string;
    path: string;
    body: Record<string, string>;
    key?: string;
  }[] = [];
  const events: Stripe.Event[] = [];
  const failures = new Map<string, { afterCommit: boolean }>();
  if (statePath && existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    for (const [key, value] of state.customers) customers.set(key, value);
    for (const [key, value] of state.checkouts) checkouts.set(key, value);
    for (const [key, value] of state.subscriptions)
      subscriptions.set(key, value);
    for (const [key, value] of state.parameters)
      parameters.set(key, new URLSearchParams(value));
    for (const [key, value] of state.idempotency) idempotency.set(key, value);
    events.push(...state.events);
  }
  let saved = '';
  function save() {
    if (!statePath) return;
    const text = JSON.stringify({
      customers: [...customers],
      checkouts: [...checkouts],
      subscriptions: [...subscriptions],
      parameters: [...parameters].map(([k, v]) => [k, v.toString()]),
      idempotency: [...idempotency],
      events,
    });
    // Reads outnumber writes here; skip the rewrite when nothing changed.
    if (text === saved) return;
    saved = text;
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(`${statePath}.tmp`, text, { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  }
  const prices = { monthly: 'price_dev_monthly', yearly: 'price_dev_yearly' };
  const webhookSecret = 'whsec_pgstencil_local_only';
  let origin = '';
  let webhookTarget: string | undefined;
  const id = (prefix: string) => `${prefix}_${token(random, 12)}`;
  const seconds = () => Math.floor(time.now().getTime() / 1000);
  function event(type: Stripe.Event.Type, object: unknown) {
    const value = {
      id: id('evt'),
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: seconds(),
      livemode: false,
      type,
      data: { object },
      pending_webhooks: 1,
      request: null,
    } as Stripe.Event;
    events.push(structuredClone(value));
    return value;
  }
  function periodEnd(price: string) {
    const end = time.now();
    if (price === prices.yearly) end.setUTCFullYear(end.getUTCFullYear() + 1);
    else end.setUTCMonth(end.getUTCMonth() + 1);
    return Math.floor(end.getTime() / 1000);
  }
  function completeCheckout(sessionId: string) {
    const session = checkouts.get(sessionId);
    if (!session || session.status !== 'open')
      throw new Error('No open checkout');
    if (session.expires_at <= seconds()) throw new Error('Checkout expired');
    const p = parameters.get(sessionId)!;
    if (p.get('payment_method_collection') !== 'always')
      throw new Error('Expected card collection');
    const days = Number(p.get('subscription_data[trial_period_days]') ?? 0);
    const price = p.get('line_items[0][price]')!;
    const sub = {
      id: id('sub'),
      object: 'subscription',
      customer: session.customer,
      livemode: false,
      status: days ? 'trialing' : 'active',
      trial_end: days ? seconds() + days * 86400 : null,
      cancel_at_period_end: false,
      metadata: {
        pgstencil_owner: p.get('subscription_data[metadata][pgstencil_owner]'),
        pgstencil_operation: p.get(
          'subscription_data[metadata][pgstencil_operation]',
        ),
      },
      items: {
        object: 'list',
        has_more: false,
        data: [
          {
            id: id('si'),
            quantity: 1,
            price: { id: price },
            current_period_end: days
              ? seconds() + days * 86400
              : periodEnd(price),
          },
        ],
      },
    } as unknown as Stripe.Subscription;
    subscriptions.set(sub.id, sub);
    session.status = 'complete';
    session.subscription = sub.id;
    session.payment_status = days ? 'no_payment_required' : 'paid';
    event('checkout.session.completed', session);
    event('customer.subscription.created', sub);
    save();
    return sub;
  }
  function completePayment(sessionId: string) {
    const session = checkouts.get(sessionId);
    if (
      !session ||
      session.mode !== 'payment' ||
      session.status !== 'open' ||
      session.expires_at <= seconds()
    )
      throw new Error('No open payment checkout');
    session.status = 'complete';
    session.payment_status = 'paid';
    event('checkout.session.completed', session);
    save();
    return session;
  }
  function transition(
    subscriptionId: string,
    action: 'renew' | 'payment-failed' | 'cancel' | 'cancel-at-period-end',
  ) {
    const sub = subscriptions.get(subscriptionId);
    if (!sub) throw new Error('Subscription not found');
    if (action === 'cancel-at-period-end') sub.cancel_at_period_end = true;
    else if (action === 'cancel') sub.status = 'canceled';
    else {
      sub.status = action === 'renew' ? 'active' : 'past_due';
      sub.items.data[0]!.current_period_end = periodEnd(
        sub.items.data[0]!.price.id,
      );
    }
    const result = event(
      action === 'cancel'
        ? 'customer.subscription.deleted'
        : 'customer.subscription.updated',
      sub,
    );
    save();
    return result;
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body = new URLSearchParams(raw);
      const path = url.pathname;
      // This UI contains no card fields and cannot charge anyone.
      if (path.startsWith('/checkout/')) {
        const session = checkouts.get(path.split('/')[2]!);
        if (!session) {
          res.writeHead(404).end();
          return;
        }
        if (req.method === 'POST') {
          if (req.headers.origin !== origin) {
            res.writeHead(403).end();
            return;
          }
          if (session.mode === 'payment') completePayment(session.id);
          else completeCheckout(session.id);
          if (webhookTarget) await deliver(webhookTarget);
          const success = new URL(
            parameters.get(session.id)!.get('success_url')!,
          );
          if (webhookTarget) {
            const target = new URL(webhookTarget);
            success.protocol = target.protocol;
            success.host = target.host;
          }
          res
            .writeHead(303, {
              location: success.href,
            })
            .end();
        } else {
          res
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(
              '<!doctype html><title>StripeDev</title><h1>Local Stripe checkout</h1><p>This simulates providing a card. No real payment is possible.</p><form method="post"><button>Provide test card and start subscription</button></form>',
            );
        }
        return;
      }
      if (path.startsWith('/portal/')) {
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(
            '<!doctype html><title>StripeDev portal</title><h1>Local billing portal</h1><p>Subscription changes are controlled by the StripeDev test API. Production uses Stripe’s hosted billing portal.</p>',
          );
        return;
      }
      const key =
        typeof req.headers['idempotency-key'] === 'string'
          ? req.headers['idempotency-key']
          : undefined;
      requests.push({
        method: req.method!,
        path,
        body: Object.fromEntries(body),
        ...(key ? { key } : {}),
      });
      const failure = failures.get(path);
      failures.delete(path);
      if (failure && !failure.afterCommit) {
        res
          .writeHead(503)
          .end(
            JSON.stringify({ error: { message: 'StripeDev injected outage' } }),
          );
        return;
      }
      const cacheKey = `${path}:${key}`;
      const cached = key ? idempotency.get(cacheKey) : undefined;
      let result: unknown;
      if (cached) {
        if (cached.input !== raw)
          throw new Error('Idempotency parameters changed');
        result = cached.result;
      } else if (path === '/v1/customers' && req.method === 'POST') {
        result = {
          id: id('cus'),
          object: 'customer',
          email: body.get('email'),
          livemode: false,
        };
        customers.set(
          (result as { id: string }).id,
          result as Record<string, unknown>,
        );
      } else if (path === '/v1/checkout/sessions' && req.method === 'POST') {
        const sessionId = id('cs');
        const session = {
          id: sessionId,
          object: 'checkout.session',
          status: 'open',
          mode: body.get('mode'),
          customer: body.get('customer'),
          client_reference_id: body.get('client_reference_id'),
          metadata: Object.fromEntries(
            [...body]
              .filter(([key]) => /^metadata\[[^\]]+\]$/.test(key))
              .map(([key, value]) => [key.slice(9, -1), value]),
          ),
          subscription: null,
          payment_status: 'unpaid',
          livemode: false,
          expires_at: Number(body.get('expires_at')),
          url: `${origin}/checkout/${sessionId}`,
        } as Stripe.Checkout.Session;
        if (session.mode === 'payment') {
          session.customer_email = body.get('customer_email');
          session.line_items = {
            object: 'list',
            has_more: false,
            url: '',
            data: [
              {
                id: id('li'),
                quantity: Number(body.get('line_items[0][quantity]')),
                price: { id: body.get('line_items[0][price]') },
              } as Stripe.LineItem,
            ],
          };
        }
        checkouts.set(sessionId, session);
        parameters.set(sessionId, body);
        result = session;
      } else if (path.startsWith('/v1/checkout/sessions/')) {
        const session = checkouts.get(path.split('/')[4]!);
        if (!session) throw new Error('Unknown checkout');
        if (path.endsWith('/expire')) {
          if (session.status !== 'open')
            throw new Error('Checkout is not open');
          session.status = 'expired';
        } else if (session.status === 'open' && session.expires_at <= seconds())
          session.status = 'expired';
        session.url = `${origin}/checkout/${session.id}`;
        result = session;
      } else if (path === '/v1/subscriptions' && req.method === 'GET') {
        result = {
          object: 'list',
          has_more: false,
          data: [...subscriptions.values()].filter(
            (s) => s.customer === url.searchParams.get('customer'),
          ),
        };
      } else if (
        path === '/v1/billing_portal/sessions' &&
        req.method === 'POST'
      ) {
        result = {
          id: id('bps'),
          object: 'billing_portal.session',
          url: `${origin}/portal/${body.get('customer')}`,
        };
      } else {
        res.writeHead(404).end(
          JSON.stringify({
            error: { message: 'Unsupported StripeDev endpoint' },
          }),
        );
        return;
      }
      if (key && !cached)
        idempotency.set(cacheKey, {
          input: raw,
          result: structuredClone(result),
        });
      save();
      if (failure?.afterCommit) {
        res
          .writeHead(503, {
            'content-type': 'application/json',
            'stripe-should-retry': 'false',
          })
          .end(
            JSON.stringify({
              error: {
                message: 'StripeDev lost response after committing operation',
              },
            }),
          );
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(result));
    } catch (error) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  const stripe = new Stripe('sk_test_pgstencil_local_only', {
    host: '127.0.0.1',
    port,
    protocol: 'http',
    maxNetworkRetries: 0,
    timeout: 5000,
  });
  function signed(value: Stripe.Event) {
    const body = JSON.stringify(value);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: webhookSecret,
      timestamp: seconds(),
    });
    return { body, signature };
  }
  async function deliver(target: string) {
    while (events.length) {
      const { body, signature } = signed(events[0]!);
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        throw new Error(`Webhook delivery failed: ${response.status}`);
      events.shift();
      save();
    }
  }
  return {
    stripe,
    prices,
    webhookSecret,
    origin,
    customers,
    checkouts,
    requests,
    events,
    completeCheckout,
    completePayment,
    transition,
    signed,
    deliver,
    setWebhookTarget(target: string) {
      webhookTarget = target;
    },
    failNext(path: string, afterCommit = false) {
      failures.set(path, { afterCommit });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

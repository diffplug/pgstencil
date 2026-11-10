import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, expect } from 'vitest';
import { DevRandom, DevTime } from '../../packages/pgstencil/src/index.ts';
import { createStripeDev } from '../../packages/stripe/src/testing.ts';

test('Checkout returns to the frontend and substitutes the session ID', async () => {
  const dev = await createStripeDev(
    new DevTime('2020-01-01'),
    new DevRandom('redirect'),
  );
  const webhook = createServer((_req, res) => res.writeHead(200).end());
  webhook.listen(0, '127.0.0.1');
  await once(webhook, 'listening');
  const address = webhook.address();
  if (!address || typeof address === 'string')
    throw new Error('No webhook port');
  dev.setWebhookTarget(`http://127.0.0.1:${address.port}/webhook`);
  try {
    const session = await dev.stripe.checkout.sessions.create({
      mode: 'payment',
      expires_at: Date.parse('2020-01-01T01:00:00Z') / 1000,
      customer_email: 'buyer@example.test',
      line_items: [{ price: 'price_gift', quantity: 1 }],
      success_url:
        'https://frontend.example.test/success?session_id={CHECKOUT_SESSION_ID}',
    });
    const response = await fetch(session.url!, {
      method: 'POST',
      headers: { origin: dev.origin },
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `https://frontend.example.test/success?session_id=${session.id}`,
    );
    expect(dev.events).toHaveLength(0);
  } finally {
    await dev.close();
    webhook.closeAllConnections();
    await new Promise<void>((resolve) => webhook.close(() => resolve()));
  }
});

test('Checkout refuses payment_method_types, which the endive API versions removed', async () => {
  const dev = await createStripeDev(
    new DevTime('2020-01-01'),
    new DevRandom('payment-methods'),
  );
  try {
    const create = (methods: string) =>
      fetch(`${dev.origin}/v1/checkout/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          mode: 'subscription',
          'line_items[0][price]': dev.prices.monthly,
          'line_items[0][quantity]': '1',
          [`${methods}[0]`]: 'card',
          expires_at: String(Date.parse('2020-01-01T01:00:00Z') / 1000),
          success_url: 'https://example.test/billing',
        }),
        signal: AbortSignal.timeout(5000),
      });
    const refused = await create('payment_method_types');
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(
      'unknown parameter: payment_method_types',
    );
    const accepted = await create('allowed_payment_method_types');
    expect(accepted.status).toBe(200);
    const session = (await accepted.json()) as {
      allowed_payment_method_types: string[] | null;
    };
    expect(session.allowed_payment_method_types).toEqual(['card']);
  } finally {
    await dev.close();
  }
});

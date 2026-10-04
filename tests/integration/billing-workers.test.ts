import { test, expect } from 'vitest';
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MiniflareResponse,
} from 'miniflare';
import { createTestContext } from '../../packages/pgstencil/src/testing.ts';
import { createStripeDev } from '../../packages/stripe/src/testing.ts';
import { appMigrations } from '../../examples/login/src/migrations.ts';

const origin = 'https://worker.example.test';
const bundle = build({
  entryPoints: ['tests/support/billing-worker.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  conditions: ['workerd', 'worker'],
  external: ['node:*', 'cloudflare:*'],
  alias: Object.fromEntries(
    builtinModules
      .filter((name) => !name.startsWith('node:'))
      .map((name) => [name, `node:${name}`]),
  ),
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.js');",
  },
});

test('Billing in workerd: fetch client, Web Crypto webhooks, founding offer and purchase counts', async () => {
  const context = await createTestContext({ migrations: appMigrations });
  const dev = await createStripeDev(context.time, context.random, undefined, {
    recurring: { price_founding_50: 'year', price_founding_60: 'year' },
  });
  const outbound: string[] = [];
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: (await bundle).outputFiles![0]!.text,
      compatibilityDate: '2026-09-08',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { WEBHOOK_SECRET: dev.webhookSecret },
      hyperdrives: { HYPERDRIVE: context.database.url },
      async outboundService(req) {
        const url = new URL(req.url);
        outbound.push(`${req.method} ${url.origin}${url.pathname}`);
        if (url.origin !== 'https://stripe.invalid')
          throw new Error(`Unexpected outbound request: ${url.origin}`);
        const response = await fetch(dev.origin + url.pathname + url.search, {
          method: req.method,
          headers: Object.fromEntries(req.headers),
          ...(req.method === 'POST' ? { body: await req.text() } : {}),
        });
        return new MiniflareResponse(await response.arrayBuffer(), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
  );
  try {
    await worker.ready;
    const call = (path: string, init?: RequestInit) =>
      worker.dispatchFetch(origin + path, init as never);
    await call('/__test/time', {
      method: 'POST',
      body: context.time.now().toISOString(),
    });
    let delivered: (typeof dev.events)[number] | undefined;
    const deliver = async () => {
      while (dev.events.length) {
        delivered = dev.events[0]!;
        const { body, signature } = dev.signed(delivered);
        const response = await call('/webhook', {
          method: 'POST',
          headers: { 'stripe-signature': signature },
          body,
        });
        expect(response.status).toBe(200);
        await response.text();
        dev.events.shift();
      }
    };
    const buy = async (owner: string) => {
      const response = await call(`/checkout?owner=${owner}&plan=founding`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const { url } = (await response.json()) as { url: string };
      const session = [...dev.checkouts.values()].find((s) => s.url === url)!;
      dev.completeCheckout(session.id);
      await deliver();
    };
    await buy('alice');
    await buy('bob');
    expect(
      dev.requests
        .filter((r) => r.path === '/v1/checkout/sessions')
        .map((r) => [
          r.body['line_items[0][price]'],
          r.body['managed_payments[enabled]'],
        ]),
    ).toEqual([
      ['price_founding_50', 'true'],
      ['price_founding_60', 'true'],
    ]);
    expect(await (await call('/status?owner=bob')).json()).toMatchObject({
      access: true,
      plan: 'founding',
    });
    expect(await (await call('/counts')).json()).toEqual({
      price_founding_50: 1,
      price_founding_60: 1,
    });
    const unknown = await call('/checkout?owner=carol&plan=price_founding_50', {
      method: 'POST',
    });
    expect([unknown.status, await unknown.text()]).toEqual([
      400,
      'Unknown plan.',
    ]);
    // Web Crypto verification rejects a body its signature does not cover.
    const { signature } = dev.signed(delivered!);
    const forged = await call('/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': signature },
      body: JSON.stringify({ ...delivered!, id: 'evt_forged' }),
    });
    expect(forged.status).toBe(400);
    await forged.text();
    expect(
      outbound.every((r) => r.includes('https://stripe.invalid/v1/')),
    ).toBe(true);
  } finally {
    await worker.dispose();
    await dev.close();
    await context.close();
  }
});

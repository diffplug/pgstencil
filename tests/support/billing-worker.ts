import { DevTime, DevRandom } from '../../packages/pgstencil/src/index.ts';
import { connectDatabase } from '../../packages/pgstencil/src/postgres.ts';
import {
  Billing,
  BillingError,
  Stripe,
  type BillingDB,
} from '../../packages/stripe/src/index.ts';

type Env = {
  HYPERDRIVE: { connectionString: string };
  WEBHOOK_SECRET: string;
};
const time = new DevTime();
const random = new DevRandom('billing-worker');
const founding = ['price_founding_50', 'price_founding_60'];
// The host never resolves: the test's outbound service answers as StripeDev.
const stripe = new Stripe('sk_test_pgstencil_local_only', {
  httpClient: Stripe.createFetchHttpClient(),
  host: 'stripe.invalid',
  protocol: 'https',
  maxNetworkRetries: 0,
});

// Test-only entrypoint: it takes the owner from the request, which a real
// adapter must derive from an authenticated session.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__test/time') {
      time.set(await request.text());
      return new Response('ok');
    }
    const db = connectDatabase<BillingDB>(env.HYPERDRIVE.connectionString);
    try {
      const billing = new Billing(db, stripe, time, random, {
        prices: {
          monthly: 'price_dev_monthly',
          founding: {
            recognized: founding,
            async offer(billing) {
              const sold = await billing.purchaseCounts(founding, {
                refundDays: 30,
              });
              return founding.find((p) => !sold[p]) ?? founding.at(-1)!;
            },
          },
        },
        trialDays: 0,
        managedPayments: true,
        webhookSecret: env.WEBHOOK_SECRET,
        live: false,
        origin: 'https://worker.example.test',
      });
      const owner = url.searchParams.get('owner') ?? '';
      if (url.pathname === '/checkout' && request.method === 'POST')
        return Response.json(
          await billing.checkout(
            owner,
            `${owner}@example.test`,
            url.searchParams.get('plan') ?? '',
          ),
        );
      if (url.pathname === '/webhook' && request.method === 'POST') {
        await billing.webhook(
          await request.text(),
          request.headers.get('stripe-signature') ?? '',
        );
        return new Response('ok');
      }
      if (url.pathname === '/status')
        return Response.json(await billing.status(owner));
      if (url.pathname === '/counts')
        return Response.json(
          await billing.purchaseCounts(founding, { refundDays: 30 }),
        );
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof BillingError)
        return new Response(error.message, { status: error.status });
      throw error;
    } finally {
      await db.destroy();
    }
  },
};

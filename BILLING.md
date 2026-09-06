# Stripe subscriptions

The trial requires a card. Signing in or opening Checkout grants no access. Checkout collects payment details, creates a Stripe subscription with the configured trial, and Stripe charges the selected monthly or yearly price when the trial ends unless the customer cancels. The example uses a 14-day trial. The yearly discount is the amount of the yearly Price; there is no coupon system.

`pnpm dev` enables local StripeDev automatically. Sign in using `/dev/emails`, open Billing from your account, choose a plan, and confirm the simulated card collection. No actual card number or Stripe key is used. The simulator retains its state in `.pgstencil/stripe-dev.json` beside the persistent development database. Use one interactive development process per project and a stable `PORT`/`PUBLIC_ORIGIN` when retrying unfinished operations across restarts. Tests use independent databases, ports, clocks and simulator state.

## Integration

`@pgstencil/stripe` exports `Billing`, the official `Stripe` SDK, and `BillingDB`. `/migrations` exports `billingMigrations`; compose it with your auth and application SQL directories using `readMigrations([...])` or `allocateDatabase([...])`. Migration filenames must be globally unique and sort in dependency order. Billing tables live in `pgstencil_billing`. Applying migrations is an explicit application/deployment operation.

Construct `Billing` with a Kysely connection, a Stripe SDK instance, your `Time` and `RandomSource`, and:

```ts
{
  prices: { monthly: 'price_...', yearly: 'price_...' },
  trialDays: 14,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  live: true,
  origin: 'https://your-app.example',
  returnPath: '/billing',
  // portalConfiguration: 'bpc_...',
}
```

The HTTP adapter supplies the authorized billing-owner ID. An owner can be a user or an organization. Never accept a customer ID, price ID, return URL, quantity or owner ID directly from a browser without authorization. The example demonstrates session authentication, CSRF-protected forms, fixed server-side return paths, and raw signed webhook handling. `startProduction` accepts its `billing` configuration; create the SDK with your secret API key there, and inject your production email sender separately.

`checkout(owner, email, plan)` returns an operation ID and hosted URL. `confirmCheckout(owner, operation)` checks ownership and retrieves authoritative Stripe state; a success URL alone never grants access. `portal(owner)` opens Stripe's hosted portal. `cancelCheckout(owner)` expires an unfinished Checkout before a different plan is selected. `reconcile(owner)` repairs missed webhook state. Use it periodically for existing billing accounts as well as when displaying billing. `status(owner)` reads the synchronized entitlement without making network requests.

Access requires exactly one recognized `trialing` or `active` subscription and an unexpired trial or current billing period. Other statuses deny access. There is no implicit payment-failure grace period. Cancellation scheduled for period end retains access until that deadline. Trial eligibility is consumed once a subscription is observed and never resets when it is canceled. This is per billing owner, not a guarantee against a person creating multiple accounts.

## Production Stripe setup

Create one product and two recurring prices (monthly and yearly) in the appropriate Stripe account. Configure the customer portal for payment-method updates, invoices and cancellation at period end. If you enable monthly/yearly plan switching in the portal, explicitly choose and test its proration/effective-date behavior in your Stripe sandbox; the package does not silently choose that policy for you. Restrict the portal to the application's allowlisted prices.

Configure a webhook endpoint with the exact `STRIPE_API_VERSION` exported by the installed SDK. Send `customer.subscription.*`, `checkout.session.*`, and `invoice.*` events to your adapter. The example endpoint is `POST /webhooks/stripe`. Preserve the raw body, forward `Stripe-Signature`, enforce a body limit, and return 2xx only after `billing.webhook()` completes. The SDK checks signatures and the five-minute timestamp tolerance; the service also rejects unexpected API versions, test/live modes and Connect account events. Stripe Connect is outside this package's scope.

Events are processed under database locks and a durable event ledger. Duplicate and reordered notifications retrieve the current subscription list after acquiring the owner lock; event timestamps are not used for ordering. An upstream error rolls back synchronization and leaves a retryable failed ledger entry. Alert on failed events and reconciliation errors. Reconciliation currently rejects customers with more than 100 subscriptions rather than silently processing an incomplete list.

Customer and Checkout creation save their idempotency keys before calling Stripe. Repeated requests use the same parameters. Ambiguous creations older than 23 hours fail closed: inspect the stored key/customer/operation metadata in Stripe, restore the confirmed customer/session mapping, then retry. Do not erase the key and create another chargeable operation blindly. Retain the event and operation records for audit; this initial implementation has no automated retention job.

## Testing

`pnpm test tests/integration/billing.test.ts tests/integration/billing-http.test.ts` uses real Postgres, the real Stripe SDK, and a local HTTP simulator. It covers required-card trial enrollment, exact expiry, paid renewal, failed payment/recovery, cancellation, no repeated trial, monthly/yearly price selection, concurrent creation, lost responses, expired Checkout, owner authorization, CSRF, signatures, duplicates, ordering and webhook retries. Snapshots cover database state, outgoing Stripe requests, response headers, HTML and Markdown; existing auth tests cover deterministic cookies and email.

`createStripeDev(time, random)` provides `completeCheckout`, `transition`, `signed`, `deliver`, and `failNext`. Advancing DevTime alone does not run Stripe jobs: explicitly trigger the relevant transition, then deliver its signed event. The hosted Checkout and portal UI in production, real card validation, Stripe's own trial jobs, taxes and portal configuration still require an opt-in Stripe sandbox smoke test with real test credentials. No such credentials are required by the ordinary suite, and no live billing has been changed.

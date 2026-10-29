# Stripe subscriptions

A trial, when configured, requires a card. Signing in or opening Checkout grants no access. Checkout collects payment details, creates a Stripe subscription with the configured trial, and Stripe charges the selected plan's price when the trial ends unless the customer cancels. `trialDays: 0` charges at Checkout with no trial. The example sells monthly and yearly plans with a 14-day trial. The yearly discount is the amount of the yearly Price; there is no coupon system.

`pnpm dev` enables local StripeDev automatically. Sign in using `/dev/emails`, open Billing from your account, choose a plan, and confirm the simulated card collection. No actual card number or Stripe key is used. The simulator retains its state in `.pgstencil/stripe-dev.json` beside the persistent development database. Use one interactive development process per project and a stable `PORT`/`PUBLIC_ORIGIN` when retrying unfinished operations across restarts. Tests use independent databases, ports, clocks and simulator state.

## Integration

`@pgstencil/stripe` exports `Billing`, the official `Stripe` SDK, and `BillingDB`. `/migrations` exports `billingMigrations`; compose it with your auth and application SQL directories using `readMigrations([...])` or `allocateDatabase([...])`. Migration filenames must be globally unique and sort in dependency order. Billing tables live in `pgstencil_billing`. Applying migrations is an explicit application/deployment operation.

Construct `Billing` with a Kysely connection, a Stripe SDK instance, your `Time` and `RandomSource`, and:

```ts
{
  prices: { monthly: 'price_...', yearly: 'price_...' },
  trialDays: 14,
  // managedPayments: true,
  // automaticTax: true,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  live: true,
  origin: 'https://your-app.example',
  returnPath: '/billing',
  // portalConfiguration: 'bpc_...',
}
```

The HTTP adapter supplies the authorized billing-owner ID. An owner can be a user or an organization. Never accept a customer ID, price ID, return URL, quantity or owner ID directly from a browser without authorization. The example demonstrates session authentication, CSRF-protected forms, fixed server-side return paths, and raw signed webhook handling. `startProduction` accepts its `billing` configuration; create the SDK with your secret API key there, and inject your production email sender separately.

`checkout(owner, email, plan)` takes a configured plan name and returns an operation ID, hosted URL, and the `priceId` it charges; `email` may be null for an owner without one, and Stripe Checkout then collects it onto the customer (the first email recorded for an owner is the customer's); any other name throws `BillingError` with status 400, so an adapter may pass the submitted plan name through. `confirmCheckout(owner, operation)` checks ownership and retrieves authoritative Stripe state; a success URL alone never grants access. `portal(owner)` opens Stripe's hosted portal. `cancelCheckout(owner)` expires an unfinished Checkout before a different plan is selected; `checkout(..., { replace: true })` does that itself, instead of refusing another plan while one is open. `reconcile(owner)` repairs missed webhook state. Use it periodically for existing billing accounts as well as when displaying billing. `status(owner)` reads the synchronized entitlement without making network requests; its `plan` is the configured name whose Prices include the subscription's Price.

`checkout(owner, email, plan, { ref })` takes an optional attribution label, such as the link that led to the purchase: 1–40 lowercase letters, digits, `:` or `-`, else `BillingError` 400 before any write. It is stored on the operation (migration 006) and sent as `pgstencil_ref` in the Checkout Session's and subscription's metadata; pgstencil writes that key itself, so a ref cannot replace `pgstencil_owner` or `pgstencil_operation`. An open Checkout keeps the ref it was opened with, and its retries resend it, so a later click's ref never changes its idempotent parameters; a checkout without a ref sends exactly the parameters it did before. `completedCheckout(event, trx)` reads a verified `checkout.session.completed` event back as `{ operation, ownerId, plan, priceId, ref }` from the stored operation, and returns null for any other event or a Checkout pgstencil did not open. Call it inside `webhook`'s `apply` with its transaction to count a completion exactly once, never on redelivery.

Access requires exactly one current subscription — a status in the exported `SUBSCRIBED` list (`trialing`, `active`, `past_due`, `unpaid`, `paused`, `incomplete`) — and that it is `trialing` before its trial end or `active` before its period end. Other statuses deny access. There is no implicit payment-failure grace period. Cancellation scheduled for period end retains access until that deadline. Trial eligibility is consumed once a subscription is observed and never resets when it is canceled. This is per billing owner, not a guarantee against a person creating multiple accounts.

## Access in SQL

Migration 007's view `pgstencil_billing.owner_access` holds that rule once, for an application's own queries: one row per owner holding exactly one current subscription, with its `subscription_id`, `price_id`, `status`, and `access_until`, the instant it stops granting access (null when its status grants none). An owner grants access at time T when its row has `access_until > T`; an owner without a row has none. `status()` reads the same view and compares against the injected clock, so the two cannot disagree; application SQL passes the clock it means, such as `now()`:

```sql
SELECT EXISTS (
  SELECT FROM pgstencil_billing.owner_access a
  WHERE a.owner_id = $1 AND a.access_until > now()
    AND a.price_id = ANY ($2::text[])  -- only on these Prices, if wanted
) AS entitled
```

A filter on `owner_id` reaches the subscriptions index through the view. The view runs with its owner's privileges, so a read-only role needs only `GRANT USAGE ON SCHEMA pgstencil_billing` and `GRANT SELECT ON pgstencil_billing.owner_access`, and no grant on the tables beneath it. Grant it after migrating, since the schema is the package's.

`reconcileStale({ limit })` repairs missed renewals from a scheduled job: it reconciles up to `limit` (1–1000) owners, in a random order, that hold an `active` or `trialing` subscription yet no access by `owner_access` at the injected clock — a renewal or trial conversion whose webhook never arrived, or more than one current subscription. Every chosen owner is tried; it returns `{ reconciled, failed }`, the owner IDs reconciled and each failure as `{ ownerId, error }`. An owner Stripe has not moved on yet stays stale and is chosen again on a later run.

## Plans and prices

`prices` maps each plan name (1–64 letters, digits, `_` or `-`) to one Stripe Price ID, or to several:

```ts
const ladder = ['price_f50', 'price_f60', 'price_f70'];
const prices = {
  monthly: 'price_monthly',
  yearly: 'price_yearly',
  founding: {
    // Every Price that grants this plan: the one offered now, earlier ones, later steps.
    recognized: ladder,
    // Runs on the server before each checkout; must return one of `recognized`.
    offer: async (billing) => {
      const sold = await billing.purchaseCounts(ladder, { refundDays: 30 });
      return ladder.find((price) => sold[price]! < 100) ?? ladder.at(-1)!;
    },
  },
};
```

`checkout(owner, email, plan, { expectPrice })` refuses to charge a Price the application did not show: `expectPrice(priceId)` is checked against the Price the checkout would charge — an open Checkout's when one is reused — before any Stripe write, and again under the owner's lock, so it may be called more than once. When it returns false, `checkout` throws `BillingError` with status 409 and `code: 'unexpected-price'`; a reused open Checkout is expired first, so the next request starts at the offered Price. A page that shows `offeredPrice(plan)` passes the Price it showed, so a buyer is never sent to a cohort's Price that sold out, or an earlier one an open Checkout kept, after the page loaded.

Each Price belongs to exactly one plan. A subscription on any recognized Price grants its plan, so retiring a Price means moving it off `offer` while keeping it in `recognized`; removing it entirely makes synchronization of its subscriptions fail closed. `offeredPrice(plan)` returns what a checkout started now would charge, for display. `checkout` resolves the offer before any Stripe write and stores it on the operation: a repeated or concurrent request reuses the open Checkout at the Price it opened with, even after the offer moves on. Concurrent buyers can therefore exceed a cohort by the number of Checkouts open when it fills.

`purchaseCounts(prices, { refundDays })` counts completed purchases per Price from synchronized rows, without network requests; every requested Price appears, with 0 when unsold. A subscription counts unless:

- its status is `incomplete` or `incomplete_expired` (Stripe never completed the first payment) or `missing` (Stripe no longer lists it);
- it ended no later than its trial end, so it was never charged; or
- it ended within `refundDays` of starting, a day being 24 hours.

`purchaseStanding(subscription, { refundDays })`, a pure function exported beside `Billing`, applies the same rule to one subscription, so an application never re-derives it: it returns `purchased`, or why not — `unpurchased`, `ended-in-trial` or `refund-window`, checked in that order. It takes a synchronized row (`status(owner).subscription`) or a Stripe subscription, such as a `customer.subscription.deleted` event's object; `refund-window` there is how a refund looks. `billing.planOf(priceId)` returns the configured plan a Price grants, or null for a Price the configuration no longer recognizes, without I/O.

pgstencil reads subscriptions, not invoices, charges or refunds. A refund alone changes nothing it sees: an application that refunds must also cancel the subscription immediately, inside the window, for the seat to return — with `end`, below. Inside the window it cannot tell a refund from an immediate cancellation without one, and either returns the seat; past it, a refund keeps the seat counted. A disputed charge counts until the subscription ends. Counts include only subscriptions pgstencil created and has synchronized; rows synchronized by a release before `started_at` existed count while they lack it, and gain it on the next sync.

### Ending a subscription

`end(owner, subscriptionId, { reason })` ends one of the owner's subscriptions in Stripe at once, with `prorate: false` and `invoice_now: false`, so nothing is credited or billed, then reconciles; refunding is the application's. It first resynchronizes the owner under the owner's lock, and records `reason` — 1–40 lowercase letters, digits, `:` or `-`, else it throws — as the row's `end_reason` (migration 008) before that lock is released, so the `customer.subscription.deleted` webhook, which waits on the same lock, reads it in its context. It returns `true` when it ended the subscription, and `false`, sending and recording nothing, for one already ended, as on a retry; a subscription that is not the owner's throws `BillingError` with status 404. `end_reason` is null on every subscription `end` did not end, a customer's own cancellation included, so an application classifies an ending by it, never by Stripe's `cancellation_details.comment`, which a customer can write in the portal. A crash between Stripe's cancellation and the commit loses the reason, and the subscription still ends.

### Managed Payments

`managedPayments: true` sets `managed_payments: { enabled: true }` on every Checkout Session, making Stripe the merchant of record; the installed Stripe SDK types that parameter at `STRIPE_API_VERSION`. Checkout still sends `payment_method_collection: 'always'` and `payment_method_types: ['card']`, and the trial parameters when a trial applies. StripeDev records the parameter but does not model Managed Payments, so confirm in a Stripe sandbox that your account accepts that combination before going live. Changing the flag while a Checkout creation is still retryable changes its idempotent parameters, so Stripe rejects that retry.

### Stripe Tax

`automaticTax: true` sets `automatic_tax: { enabled: true }` on every Checkout Session, so Stripe Tax calculates tax on the first payment and on the subscription's renewals. pgstencil creates each customer without an address, which Stripe refuses for automatic tax, so the session also sends `customer_update: { address: 'auto' }`: Checkout collects the address tax needs (`billing_address_collection` stays Stripe's default `auto`) and saves it on the customer for renewals. Card collection and trial parameters are unchanged. The constructor refuses `automaticTax` together with `managedPayments`, because Stripe rejects `automatic_tax` on a Managed Payments session, which calculates tax itself. Tax registrations, product tax codes and Price tax behavior are Stripe account settings. StripeDev records the parameters and, like Stripe, rejects automatic tax for a customer without an address unless the session saves one, but it calculates no tax; confirm real amounts in a Stripe sandbox before going live. Changing the flag while a Checkout creation is still retryable changes its idempotent parameters, so Stripe rejects that retry.

## Production Stripe setup

Create the product and one recurring Price per configured Price ID in the appropriate Stripe account. Configure the customer portal for payment-method updates, invoices and cancellation at period end. If you enable plan switching in the portal, explicitly choose and test its proration/effective-date behavior in your Stripe sandbox; the package does not silently choose that policy for you. Restrict the portal to the application's allowlisted prices.

Configure a webhook endpoint with the exact `STRIPE_API_VERSION` exported by the installed SDK. Send `customer.subscription.*`, `checkout.session.*`, and `invoice.*` events to your adapter. The example endpoint is `POST /webhooks/stripe`. Preserve the raw body, forward `Stripe-Signature`, enforce a body limit, and return 2xx only after `billing.webhook()` completes. The SDK checks signatures and the five-minute timestamp tolerance; the service also rejects unexpected API versions, test/live modes and Connect account events. Stripe Connect is outside this package's scope.

Events are processed under database locks and a durable event ledger. Duplicate and reordered notifications retrieve the current subscription list after acquiring the owner lock; event timestamps are not used for ordering. An upstream error rolls back synchronization and leaves a retryable failed ledger entry. Alert on failed events and reconciliation errors. Reconciliation currently rejects customers with more than 100 subscriptions rather than silently processing an incomplete list.

Customer and Checkout creation save their idempotency keys before calling Stripe. Repeated requests use the same parameters. Ambiguous creations older than 23 hours fail closed: inspect the stored key/customer/operation metadata in Stripe, restore the confirmed customer/session mapping, then retry. Do not erase the key and create another chargeable operation blindly. Retain the event and operation records for audit; this initial implementation has no automated retention job.

`webhook(body, signature, apply)` optionally joins application database fulfillment to the same event transaction. The callback receives the verified event, the Kysely transaction, and a context read after the event's resync: `ownerId`, the billing owner the event names, else null, and for a `customer.subscription.*` event `subscription`, that subscription's synchronized row with its `end_reason`, else null. Use explicit application schemas. A failed callback rolls back both billing and application writes, and remains retryable. Keep external side effects out of this callback or persist an outbox record instead. StripeDev also supports one-time payment completion for consumer purchase tests.

## Testing

`pnpm test tests/integration/billing.test.ts tests/integration/billing-http.test.ts` uses real Postgres, the real Stripe SDK, and a local HTTP simulator. It covers required-card trial enrollment, exact expiry, paid renewal, failed payment/recovery, cancellation, no repeated trial, monthly/yearly price selection, a founding ladder with no trial, retired Prices, plan-name validation, purchase counts, concurrent creation, lost responses, expired Checkout, owner authorization, CSRF, signatures, duplicates, ordering and webhook retries. `tests/integration/billing-workers.test.ts` runs checkout, Web Crypto webhook verification, status and purchase counts inside workerd. Snapshots cover database state, outgoing Stripe requests, response headers, HTML and Markdown; existing auth tests cover deterministic cookies and email.

`createStripeDev(time, random, statePath?, { recurring })` provides `prices` (`price_dev_monthly` and `price_dev_yearly`); `recurring` adds Price IDs with a `'month'` or `'year'` interval, and subscription Checkout rejects any other Price. It also provides `completeCheckout`, `transition`, `signed`, `deliver`, and `failNext`. Advancing DevTime alone does not run Stripe jobs: explicitly trigger the relevant transition, then deliver its signed event. The `cancel` transition, like the SDK's `subscriptions.cancel` that `end` calls, ends a subscription immediately and emits `customer.subscription.deleted`. The hosted Checkout and portal UI in production, real card validation, Stripe's own trial jobs, taxes and portal configuration still require an opt-in Stripe sandbox smoke test with real test credentials. No such credentials are required by the ordinary suite, and no live billing has been changed.

# Public package and SaaS billing plan

Status: proposal for the next implementation. The repository will be public on GitHub. Two separate pnpm applications will consume the shared code; each needs authentication and SaaS subscriptions with a free trial, monthly billing, and discounted annual billing. Trial length, prices, and whether a card is required before the trial starts remain application configuration; the card policy is awaiting a user preference.

## Distribution

Publish ordinary public npm packages from this repository. Use an npm scope owned by the maintainer; the proposed core/auth/stripe package names are placeholders until the scope is chosen. Keep the existing workspace for development and release the three packages together with one version and a short changelog. Consumers pin exact package versions and commit their pnpm lockfiles, upgrading independently.

Public npm packages can be installed by anyone; a user or organization scope avoids depending on availability of a global name. The initial setup is an npm account with publishing authentication, an owned scope, package metadata, and a chosen license. Establish the first public release, then configure the package's trusted publisher to identify this repository's GitHub Actions release workflow. Build and test with pnpm; the final publishing step can use a supported npm CLI with OIDC, avoiding a stored long-lived publishing token. See [public packages](https://docs.npmjs.com/about-public-packages/), [scoped publishing](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).

GitHub Release assets are a viable fallback: attach built `pnpm pack` tarballs and depend on their versioned HTTPS URLs. Multiple related packages make this less convenient because their internal dependency references also need a resolvable distribution source. GitHub Packages adds npm registry authentication. GitHub Actions artifacts require signed-in download access and expire, making them unsuitable as permanent consumer dependencies. See [GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry), [release assets](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), and [workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).

No release management framework is needed initially. A small release script can check aligned versions, build, pack, and verify the artifacts. Publishing is an explicit release operation, not a side effect of every commit.

## Package boundaries

| Package | Shared responsibility                                                                               | Consumer responsibility                                                            |
| ------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| core    | Postgres/template setup, SQL migrations, test contexts, time/randomness/email interfaces, snapshots | Project root, application migrations, configuration, production email sender       |
| auth    | Email/OAuth/session behavior, owned SQL tables and migrations, test helpers                         | Rendering, route integration, application profiles and permissions                 |
| stripe  | Stripe subscription integration, billing persistence, webhook processing, deterministic fixtures    | Prices, trial and access policies, billing owner, product-specific features and UI |

Keep production entry points free of Docker startup and test fixture initialization. Test and database-tool exports remain explicit. Auth and billing compose through an application-supplied billing-owner identifier; billing must not assume that the signed-in individual is always the paying entity. The first example can use one user as that owner, without implementing teams or seats.

Build ESM JavaScript and TypeScript declarations using the existing TypeScript toolchain. Package the required SQL, Compose defaults, and other runtime assets with an explicit files allowlist. Exports must work without the repository's tsconfig aliases or source loaders. Project roots, state directories, migration locations, and code-generation output belong to the consumer; no installed code should walk upward into this repository's `examples/login` directory.

Auth, billing, and application SQL are explicitly named migration sets with stable ordering and checksums. Give shared tables a deliberate namespace so they cannot collide with application tables. Include every selected migration set in the template fingerprint. Consumers apply migrations in an explicit deployment step, never during dependency installation. Prove both clean initialization and upgrades preserving existing accounts, sessions, subscriptions, and application data.

CI packs the packages and installs them into an unrelated temporary pnpm project with no workspace links or source aliases. It checks public imports, declarations, assets, migration composition, generated query types, and a real login/billing flow. A second consumer fixture uses a different schema and UI to expose assumptions specific to the example. Local `file:` overrides support rapid iteration; packed-artifact testing remains the release gate.

## SaaS billing scope

Use the official Stripe Node SDK, hosted Checkout, and the Billing customer portal. One Stripe product has an allowlisted monthly recurring Price and an annual recurring Price. The annual discount is represented by the annual amount, rather than a coupon engine. Each consuming application supplies its own product/prices, branding, credentials, and trial duration. See the [Stripe SDK](https://github.com/stripe/stripe-node) and [customer portal](https://docs.stripe.com/customer-management).

The example adds a billing page showing trial/access state, current plan, next renewal or access-end date, monthly/annual choices, and a Manage billing action. Checkout and portal creation require authentication, CSRF protection, and permission to manage the relevant billing owner. The server chooses the Stripe customer, prices, quantity, metadata, and return URLs; those are not trusted from the submitted form.

Decide trial enrollment before implementing the first flow. For a no-card trial, the simplest proposed UX grants an application-managed trial on first eligible signup, then uses Checkout when the customer chooses to pay. Persist the trial deadline and eligibility once so repeated sign-ins or abandoned checkouts cannot reset it. Alternatively, Stripe-managed trials can start with or without a payment method; the latter requires an explicit cancel/pause policy at expiry. Avoid maintaining two independent trial deadlines for the same enrollment. With a card-required trial, use Checkout's subscription trial and let Stripe handle the first charge. See [Checkout trials](https://docs.stripe.com/payments/checkout/free-trials?payment-ui=stripe-hosted).

The paid path creates/reuses a Stripe Customer, opens a subscription Checkout Session, synchronizes verified billing state, and provides authenticated customer portal access for payment details, invoices, and cancellation. Start with cancellation at the end of the paid period. Monthly/annual switching and its billing effective date must be explicit and tested; do not inherit an accidental proration policy. The consumer owns access rules, including any grace period after failed payment, while billing preserves Stripe's actual status and relevant dates. See [subscription lifecycle](https://docs.stripe.com/billing/subscriptions/overview).

## Reliability and persistence

Persist the owner-to-customer mapping, checkout operations, subscription IDs/prices/status/dates, and webhook processing state. Allow only one intended SaaS subscription per billing owner. Concurrent checkout requests must converge on the same operation; abandoned sessions can expire before replacement. Use durable operation IDs as Stripe idempotency keys and recover after a response is lost. Do not generate a new key for every retry or blindly retry old ambiguous operations beyond Stripe's idempotency retention. See [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).

Verify webhook signatures using the untouched request body and the official SDK. Check expected Stripe mode/account and configured API version. Acknowledge only after either durable receipt or committed processing. A failed handler must remain retryable; inserting an event ID cannot by itself mark work complete. Postgres uniqueness and transactional writes prevent duplicate database effects. Any email or other external side effect requires its own durable retry/deduplication strategy.

Handle duplicate and out-of-order events. Refresh authoritative subscription state under a per-subscription synchronization strategy so an older event cannot restore canceled access. Event timestamps alone cannot establish order. Provide an explicit reconciliation operation to repair stale state after missed events or downtime. The browser's success redirect does not grant paid access; it can request an authenticated synchronization of the saved checkout operation. See [Stripe webhook delivery](https://docs.stripe.com/webhooks).

## Deterministic tests

Add a small `StripeDev` helper, following EmailDev, implementing only the endpoints and scenarios used by this package. The production adapter still uses the real Stripe SDK. Local HTTP fixtures record outgoing requests and idempotency keys, supply controlled responses, and deliver signed webhook bodies through the application's real HTTP route. Unexpected API operations fail the test. Instances have isolated state and dynamic ports.

Use the injected application clock and randomness for local billing deadlines, operation IDs, and snapshots. Scenario methods explicitly simulate payment success/failure, renewal, cancellation, and webhook delivery; advancing DevTime does not implicitly run jobs or pretend to move Stripe's real clock. Webhook signature verification keeps its real timestamp-tolerance check in production, with a controlled receipt timestamp in tests using the SDK's supported seam.

Required cases: trial expiry exactly at its boundary; no repeated trial; monthly/annual price selection; concurrent checkout and API retries; checkout abandonment; paid access without a browser return; forged return URLs; invalid signatures; duplicate/concurrent/reordered webhooks; rollback followed by successful retry; renewal success and failure; cancellation at period end; one user's inability to open another customer's portal; and two applications running independently in parallel. Snapshot queries, headers/cookies, HTML/Markdown, outgoing Stripe requests, and any application-generated emails.

Do not add stripe-mock as a default dependency: its maintainers explicitly describe it as stateless and unsuitable for behavioral regression tests. See [stripe-mock's limitations](https://github.com/stripe/stripe-mock). Add a separate opt-in suite against a real Stripe sandbox with test clocks for trial/renewal transitions and a manual hosted Checkout/portal smoke test. These require test credentials; ordinary tests remain offline apart from local Docker. Stripe test clocks and application DevTime are separate clocks. See [Stripe test clocks](https://docs.stripe.com/billing/testing/test-clocks).

## Implementation order

1. Finish and preserve the current Claude simplify pass.
2. Extract core/auth package boundaries and consumer configuration; keep existing auth tests and snapshots passing.
3. Build, pack, and test installation in independent consumer fixtures, including shared/app migration upgrades.
4. Implement the chosen SaaS trial and monthly/annual Checkout flow with the official Stripe SDK and local fixtures.
5. Add webhook recovery, renewal/cancellation, portal, reconciliation, concurrency tests, and readable billing snapshots.
6. Prepare the public release workflow and first release artifacts. Confirm the npm namespace and license, then complete account/trusted-publisher setup and the explicitly requested publication.

The existing user instruction to commit incrementally applies to each implementation milestone. This plan does not create Stripe products, change real billing, or publish a package.

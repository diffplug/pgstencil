# Domain: security

**Scope — these, and no others:**

- `SECURITY.md`: every `FAIL IF`, and the code and tests each bullet names
- `packages/stripe/src/`: the `Billing` class in `index.ts` and `db.ts`, and
  the StripeDev simulator in `testing.ts` that the billing suites run against
- `packages/stripe/migrations/`: the `pgstencil_billing` schema and its
  `owner_access` view
- the billing suites: `tests/integration/billing.test.ts`,
  `tests/integration/billing-security.test.ts`,
  `tests/integration/billing-workers.test.ts` and
  `tests/integration/billing-http.test.ts`

**Output file:** `audit-report.md`

This is a code-and-policy audit of what the packed packages guarantee to a
consuming application. Everything `SECURITY.md` assigns to the application —
TLS, the origin gate, page CSP, secret storage, database provisioning, provider
registration, and for billing the owner's authentication, CSRF on its billing
routes, raw-body webhook delivery, Stripe key storage and the Stripe account's
configuration — is out of scope; so is the rest of `@pgstencil/stripe` that
`SECURITY.md` lists under "What is not defended".

## Mechanical pass

Run every `FAIL IF` in `SECURITY.md`. Most of them are pinned by a named test,
so start by running the suites and reading their assertions, then read the code
each bullet names.

```sh
pnpm db:verify          # migrations apply and match the committed schema
pnpm test:unit          # diagnostics allowlist and the other unit rules
pnpm exec vitest run tests/integration/better-auth.test.ts \
  tests/integration/better-auth-workers.test.ts \
  tests/integration/better-auth-oauth.test.ts   # the session, CSRF, email-code, OAuth and linking suites
pnpm exec vitest run tests/integration/billing.test.ts \
  tests/integration/billing-security.test.ts \
  tests/integration/billing-workers.test.ts \
  tests/integration/billing-http.test.ts   # the webhook, checkout and entitlement suites
pnpm packages:verify    # packs, installs into a clean project, checks provenance
```

The auth suites, the billing suites and `packages:verify` need a working
Docker daemon (see `compose.yaml`). If the daemon is unreachable, every check those suites pin is
`UNVERIFIABLE` — say so and say why. **Never record a check as PASS on the
strength of a test you did not run**, and never quietly skip one.

Each `Pinned by` line at the end of a `SECURITY.md` section names the tests for
that section. Confirm each named test still exists and still asserts what the
bullet claims: a test that was renamed, skipped, or reduced to a smoke check
leaves its bullet unenforced, and that is a finding even when the code is fine.

The remaining bullets are read rather than run:

- The `Continuous checks` bullets are grep-and-read over
  `.github/workflows/check.yml` and `.github/workflows/security-audit.yml`.
  Check the triggers, the job names, `persist-credentials: false`, the
  permission blocks, the reporting step's verdict grammar, and that the
  redaction step is present and covers every file the archive step publishes.
- The environment deployment-branch policy and the active rules for `main`
  require live GitHub API reads, not just workflow inspection. Run both `gh api`
  commands in `SECURITY.md` with `--paginate`; CI supplies `GH_TOKEN` and the
  existing `actions: read` permission, while local runs use your `gh` login.
  If either request fails, record it as `UNVERIFIABLE` with the API error;
  never infer the live settings from the workflow's comments.
- The `Packed provenance` bullets are read over `scripts/build-packages.ts`,
  `scripts/pack-packages.ts` and `scripts/verify-packages.ts`, with
  `pnpm packages:verify` as the evidence.
- The `Stripe webhooks`, `Checkout` and `Entitlement` bullets are pinned by the
  billing suites, and each also names the `Billing` members to read in
  `packages/stripe/src/index.ts`. Read those members in full: several clauses
  (the tolerance, the injected clock, the order of the ledger, resync and
  `apply`, what `synchronize` checks) are statements about the code that a
  passing test only samples. Compare `SUBSCRIBED` with the status list in
  `007_billing_owner_access.sql` character for character.

## Qualitative pass

Be adversarial, and go past the `FAIL IF` list. Read
`packages/auth/src/better-auth*.ts`, `packages/pgstencil/src/*.ts`,
`packages/stripe/src/index.ts`, `packages/stripe/migrations/*.sql`, and the
suites under `tests/` — including what they do _not_ cover. Ask at least:

- **Can a caller influence where an OAuth callback lands, or reuse state across
  applications?** Trace `oauthRequest` in `better-auth-oauth.ts` from the start
  of the flow through the signed state cookie, the `oauth_flows` row, and the
  atomic claim in `003_oauth_claims.sql`. Every parameter beyond the provider
  name must come from server configuration; a state row must bind the browser,
  the provider, and one application.
- **Does `verifiedOidc` cover every enabled provider?** Compare the providers in
  `socialProviders` against the ones `verifiedOidc` and `providerSubject` in
  `better-auth-email.ts` actually verify. A provider that is enabled but falls
  through the verification switch signs users in on an unverified assertion.
- **Can a real user register an address in the `identity.pgstencil.invalid`
  namespace?** Trace every writer of a user email — sign-up, linking,
  `allowMissingEmail` account creation, and any profile update — against
  `isIdentityEmail`. A reserved namespace that is only filtered on the way out
  is not reserved.
- **Can a raw upstream error carrying a token reach diagnostics?** Follow a
  provider or database error from where it is thrown to `diagnostic` and
  `diagnosticError` in `packages/pgstencil/src/diagnostics.ts`, and to
  `onAPIError`. Look for a path that stringifies an exception, a response body,
  or a URL with a query string.
- **Is any rate-limit key derivable without the application secret?** Read
  `keyed` and `consume` in `better-auth-security.ts`. A key an attacker can
  compute lets them exhaust another address's budget, and one that varies with
  something the caller controls lets them escape their own.
- **Can `@pgstencil/auth/better-auth-testing` be reached from a production
  import graph?** Start at the package's `exports` map, then at
  `examples/better-auth/src/worker.ts` and the esbuild `inject` that only test
  bundles carry. A conditional import, a re-export, or a bundler that keeps the
  module is the finding, not the presence of the file.
- **In `packages/pgstencil/src/database.ts` and `paths.ts`, is any shell or
  Compose invocation built from a path or environment value a project could
  control?** `PGSTENCIL_PROJECT_ROOT`, the derived Compose project name, the
  `pgstencil.json` migrations path, and the bundled `compose.yaml` fallback all
  cross into a child process. Look for string-built commands, unquoted
  interpolation, and a path that escapes the project root.
- **Can anything from a webhook body reach a billing table, or grant access?**
  Follow every read of `event` in `webhook` and `completedCheckout` in
  `packages/stripe/src/index.ts`. The body may choose whose state to resync and
  which row `context.subscription` reads back; anything more — a status, a
  period end, a Price, an owner taken from metadata — is the finding.
- **Can one owner end up with two chargeable subscriptions, a second trial, or
  another owner's Checkout?** Trace `checkout` through `account`, `customer`,
  `reconcile`, the locked transaction and the Stripe call made after it
  commits, and `cancelCheckout` and `replace` racing a completion in Stripe.
  Check that every Stripe write is either keyed by a value committed first or
  safe to repeat.
- **Does a billing error path leak?** `verifyWebhook` puts the Stripe SDK's
  message into the `BillingError` an adapter may return to the sender; follow
  every error `webhook` raises to `diagnostic`, and look for a path that
  serializes a body, a header, a secret or a message.
- **Does a billing test pin what its bullet claims, or only what StripeDev
  allows?** `packages/stripe/src/testing.ts` is a simplified Stripe; a test
  whose assertion holds only because the simulator cannot produce the bad case
  leaves its clause unenforced.
- **What do the integration tests not cover?** Name the gaps. A guarantee whose
  only evidence is that nobody has attacked it is worth saying out loud.
- **Have `SECURITY.md` and the code drifted?** Say which side is wrong. A bullet
  that describes a control the code no longer has is a BLOCKER; a control the
  code has that the file does not claim is an INFO.

Rate every finding BLOCKER, WARNING or INFO, and give each one a file path and
line number.

# Changelog

The three packages (`pgstencil`, `@pgstencil/auth`, `@pgstencil/stripe`) share one version. They are 0.x releases: a minor version may break compatibility, and each breaking change below says how an application adapts. Releases before 0.5.0 are recorded only in the Git history, with one note for an application upgrading across them: since 0.4.0, `testcontainers`, `node-pg-migrate`, `cheerio` and `turndown` are optional peers that the application installs itself, usually as devDependencies ([PACKAGES.md](PACKAGES.md#tooling-peers)).

## Unreleased

Nothing yet.

## 0.5.1 (2026-11-10)

Fixes and compatible additions found while two applications adopted 0.5.0.

### Fixed

- **`pgstencil create` no longer writes into an installed package.** It wrote into the last configured source without checking, so a project whose sources were all package directories got a new SQL file inside `node_modules`. It now refuses any target inside `node_modules`, the default or one given with `--in`.
- **`pgstencil status`, `validate` and `migrate` refuse a `DATABASE_URL` that is set but empty.** 0.5.0 passed the empty string to the driver, which then connected with its own defaults. An empty value is how a workflow sees a secret it lost.
- **`pgstencil reset` refuses to run while `DATABASE_URL` is set.** It only ever recreates the development database and used to ignore the variable silently.
- **`@pgstencil/auth`: the default sign-in sender is a valid address for an IP origin**: `signin@[127.0.0.1]`, or `signin@[IPv6:…]`, where it was `signin@127.0.0.1`. A non-blank `emailFrom` is trimmed.
- **This changelog's 0.5.0 entry** gains the notes it was published without: the stripe 23 and Stripe API version move, the Better Auth pin, and the optional tooling peers introduced in 0.4.0.

### Added

- **`pgstencil status|validate|migrate --also <dir>`**, repeatable: one more migration source after the configured ones for that run, for SQL only some databases get, such as previews.
- **`pgstencil status|validate|migrate --require-database-url`**: fail when `DATABASE_URL` is unset instead of using the development database.
- **`--env-file <path>` and `--env-file-if-exists <path>`** on every `pgstencil` command, loaded before configuration is read.
- **`pgstencil/email`** subpath: the email types, `EmailDev` and `escapeHtml` without the root's `node:crypto` import, for code a browser also loads. The `pgstencil` package also declares `"sideEffects": false`, so a production bundle that imports only `escapeHtml` from the root drops the rest.

One message changed: `pgstencil status <argument>` reports `status accepts only --also <dir> and --require-database-url` where it said `status takes no arguments`.

## 0.5.0 (2026-11-10)

This release is breaking.

### Stripe 23 and a new Stripe API version

These notes were missing when 0.5.0 was published.

`@pgstencil/stripe` now peers on `stripe ^23.1.0` (0.4.3 accepted `^22.6.1`), so an application must move its own `stripe` dependency to 23. That moves `STRIPE_API_VERSION` to `2026-10-28.endive`, and `verifyWebhook` refuses an event at any other version, so this upgrade is a webhook cut-over, not a routine bump:

- Create a webhook endpoint at `2026-10-28.endive` and give the new release its signing secret before it serves traffic, then retire the old endpoint. [BILLING.md](BILLING.md#moving-to-a-new-stripe-api-version) has the full procedure.
- Checkout sessions send `allowed_payment_method_types: ['card']` where they sent `payment_method_types: ['card']`, which Stripe 23 removed. A Checkout creation whose response was lost just before the deploy is retried with the new parameters under its saved idempotency key, which Stripe refuses; repair that owner as for any ambiguous creation.
- `verifyWebhook` passes its 300-second tolerance explicitly, so its behaviour is the same under stripe 23, which changed the SDK's default.
- `Billing.reconcileAll({ dryRun, pageSize })` reconciles every owner holding a Stripe customer and reports what changed, for a one-off pass after a cut-over like this one.
- StripeDev models the stripe 23 subscription and Checkout shapes, and gains `pause` and `resume` transitions.

`@pgstencil/auth` moves its exact Better Auth pin from 1.7.16 to 1.7.18, which changes an application's lockfile and any dependency disclosure it publishes.

### Removed: the original code/link authentication

`@pgstencil/auth` is now only the Better Auth integration. The original implementation, which the earlier releases kept beside it, is gone:

- The subpath exports `@pgstencil/auth/auth`, `/oauth`, `/oauth-providers`, `/security`, `/email`, `/http`, `/fetch`, `/hono`, `/workers`, `/migrations` and `/db.generated`, with everything they exported (`Auth`, `OAuth`, `OAuthProviders`, `createAuthHttp`, `createAuthFetch`, `createAuthHono`, `createAuthWorker`, `authMigrations`, `digest`, `keyed`, `escape`, `loginEmail` and the rest).
- The `migrations/` directory in the package (`001_auth.sql`, `002_oauth.sql`, `004_oauth_workers.sql`).
- The `openid-client` dependency.
- The `examples/login` and `examples/workers` applications. `examples/better-auth` is the one example; it now carries the billing demo and the deployable Workers entry.

The package root changed meaning: `import … from '@pgstencil/auth'` now gives `createAuthApp`, `authOptions` and their types, the same module as `@pgstencil/auth/better-auth`. The `./better-auth*` and `./postmark` subpaths are unchanged.

How to adapt:

- **A database that applied the old migrations.** Applied SQL stays under checksum validation, so the three files must still be among your sources. Copy them, byte for byte and with the same names, from `@pgstencil/auth` 0.4.3 into a directory of their own in your repository, and list that directory where you listed `authMigrations`. Keep it a separate source rather than merging it into your application's directory: each source's applied history must be a prefix of that source's files, which a merged directory may not satisfy. A later migration of your own can drop the old tables.
- **`escape` from `@pgstencil/auth/email`.** Use `escapeHtml` from `pgstencil`; it behaves the same.
- **`digest` from `@pgstencil/auth/security`.** It was `createHash('sha256').update(value).digest('hex')` from `node:crypto`; inline that.
- **The `OAuthFetch` type from `@pgstencil/auth/oauth-providers`.** It was a test-fixture type. `tests/support/oauth-server.ts` now declares it locally; a copy of that fixture should take the updated file.
- **Anything else from the removed modules.** Move to the Better Auth integration ([PACKAGES.md](PACKAGES.md#better-auth-integration)); its sessions and accounts are independent of the old tables.

### Changed

- **`pgstencil/database`: `defaultMigrations` is always a list.** `pgstencil.json`'s `migrations` accepts one directory or an ordered list, and `defaultMigrations` is the resolved `readonly string[]` either way. Spread it where you built a list around it: `[...defaultMigrations, billingMigrations]`. `createTestContext()`, `allocateDatabase()`, `prepareTemplate()` and `developmentDatabase()` without a source argument use the whole configured list.
- **`pgstencil.json` is validated strictly** when `pgstencil/database` is imported. Its only keys are `migrations`, `schema` and `types`; a file with any other key, `$schema` included, used to have it ignored and now fails on import.
- **`@pgstencil/auth`: the default sign-in email's sender** is `signin@<hostname of origin>` instead of `signin@example.test`. `postmarkEmail(token, from)` still sends from its own `from`, so a Postmark deployment sends as before; an inbox fixture or another transport sees the new address. Set `emailFrom` to choose it.
- **`@pgstencil/auth`: a code type other than sign-in** fails with `Email codes are not supported for <type>`.
- **`@pgstencil/stripe`: reconciliation paginates.** A customer with more than 100 subscriptions, ended ones included, used to fail every reconciliation and webhook with `Subscription reconciliation requires pagination`. Every page is now read under the same owner lock.
- **`@pgstencil/stripe`: `BillingDB` is checked against the migrations.** It is still hand-written, because it is narrower than what a generator can infer for the `owner_access` view, but the billing schema's declarations are now also generated to `db.generated.ts` and the two are compared column by column at compile time. `pnpm db:verify` fails when a billing migration changes without regenerating, and `pnpm typecheck` fails when `BillingDB` disagrees. The type itself is unchanged.

### Added

- **`pgstencil` command.** The core package ships the database commands this repository's `pnpm db:*` scripts ran privately: `status`, `validate`, `migrate`, `create`, `schema`, `types`, `verify`, `reset`, `gc` and `stop`, configured by `pgstencil.json` (`migrations`, `schema`, `types`). `types` needs the new optional peer `kysely-codegen`, run through its API, so a project's own kysely-codegen configuration file is not read. An application can replace its own migration script with `pnpm exec pgstencil <command>`; see [README.md](README.md#change-the-schema). `pgstencil/database` also exports `projectConfig`, `readConfig`, `parseConfig` and the `ProjectConfig` and `TypesTarget` types.
- **`pgstencil`: `escapeHtml(value)`** for values interpolated into an email's HTML.
- **`@pgstencil/auth`: `emailFrom` and `renderEmail`** on `createAuthApp` and `createBetterAuthWorker` (where `emailFrom` may be `(env) => string`), with the exported `defaultSignInEmail` and `SignInEmailInput`. A rendered message must be addressed to the requested recipient alone; anything else, or a renderer that throws, delivers nothing.
- **`@pgstencil/auth/postmark`:** a failed delivery's `EmailDeliveryError` carries Postmark's numeric `ErrorCode` as `providerCode` for HTTP errors too, and it reaches diagnostics. Never the message text.
- **`@pgstencil/stripe`: `Billing.pruneEvents({ olderThanDays })`** trims processed events from the webhook ledger, for a scheduled job. The retention is 30 to 3650 days; unprocessed and failed events are always kept. A pruned event that is delivered again is processed again, `apply` included.
- **StripeDev** paginates `subscriptions.list` (`limit`, `starting_after`, `has_more`) and records a GET's query parameters in `requests`.
- **[SECURITY.md](SECURITY.md) covers billing.** Sixteen `FAIL IF` rules for webhooks, checkout and entitlement, each pinned by a test, are now part of the audit that gates a release.

### Repository

- Node is pinned once, in the root `package.json`'s `devEngines.runtime` (24.22.2). pnpm downloads and uses that version for every script, and all three workflows read it, so checks, audits and releases run on Node 24, the declared minimum, where they used to run on 26. `.nvmrc` is gone. Every action in `check.yml` is pinned to a commit.
- `PLAN.md`, `DISTRIBUTION_AND_BILLING_PLAN.md`, `LOGIN_FLOW.md` and `OAUTH.md` are deleted: the first two described finished work, the others the removed implementation. Provider registration notes moved to [the example](examples/better-auth/README.md#provider-registration).

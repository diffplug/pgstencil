# Changelog

The three packages (`pgstencil`, `@pgstencil/auth`, `@pgstencil/stripe`) share one version. They are 0.x releases: a minor version may break compatibility, and each breaking change below says how an application adapts. Releases before 0.5.0 are recorded only in the Git history.

## Unreleased

Nothing yet.

## 0.5.0 (2026-11-10)

This release is breaking.

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

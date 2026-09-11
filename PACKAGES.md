# Consuming pgstencil

Three packages share version 0.1.0: `pgstencil` (infrastructure and test primitives), `@pgstencil/auth` (email/OAuth/session services and a JSON HTTP adapter), and `@pgstencil/stripe` (SaaS billing and StripeDev). They are private workspace packages for now; no registry account is needed to consume their tarballs.

Run `pnpm packages:pack` to produce the three archives in `dist/packages`. They contain ESM JavaScript, TypeScript declarations, the MIT license, and required SQL/Compose assets. Workspace development uses source exports; packing switches the exports to compiled files. Nothing runs migrations during install.

Copy the tarballs to a consumer's `vendor/` directory, depend on them using `file:` paths, and override all three package names to those same paths in the consumer's pnpm configuration. The override for `pgstencil` ensures auth and billing's transitive dependency also resolves locally. Commit the archives and lockfile together for a reproducible temporary distribution. Once public npm is configured, replace these paths with exact registry versions and remove the overrides.

`pnpm packages:verify` builds, packs, installs into an unrelated temporary pnpm project, checks TypeScript declarations, and runs an email login and required-card trial against a real cloned database. It shares this repository's Docker service state, but loads all code and SQL from installed archives. The consumer directory is printed for inspection.

## Application composition

Production imports use `pgstencil`, `pgstencil/postgres`, `@pgstencil/auth` and `@pgstencil/stripe`. Docker startup and test fixtures are opt-in imports through `pgstencil/database`, `pgstencil/testing`, and `@pgstencil/stripe/testing`.

The database tooling uses the current working directory as the project root, or `PGSTENCIL_PROJECT_ROOT` when explicitly set. State goes in that project's `.pgstencil`; its Docker Compose project name derives from the project path. A project can supply `compose.yaml`, otherwise the package's bundled default is used. The default SQL directory is `migrations`, overridable by a `pgstencil.json` file containing a `migrations` directory path. Applications composing packages should pass their complete source list explicitly:

```ts
import { authMigrations } from '@pgstencil/auth/migrations';
import { billingMigrations } from '@pgstencil/stripe/migrations';
const sources = [authMigrations, billingMigrations, applicationMigrations];
```

Every source is an append-only ordered directory of numbered SQL files. Filenames must be globally unique; include a package/application label, such as `100_ttr_purchases.sql`. Each source's applied history must remain a prefix of that source's current files. A package can therefore introduce a new migration with a lower number than another source's already-applied migration. Pending files execute in filename order, and every applied file retains checksum protection. Test package upgrades against existing application data as well as clean initialization.

Auth reserves the existing `public.users`, `login_flows`, `login_challenges`, `sessions`, `rate_limits`, `oauth_identities`, and `oauth_flows` tables. Their original SQL bytes and names are preserved for upgrades. Billing reserves the `pgstencil_billing` schema. Application SQL must avoid those names.

`Auth` accepts a `renderEmail` function for branding. `createAuthHttp` from `@pgstencil/auth/http` supplies JSON routes under `/api/auth/`, native OAuth callbacks under `/oauth/`, and a non-consuming email-link redirect under `/login/link`. The SPA confirms the link with an authenticated browser-flow POST. Session tokens stay in HttpOnly cookies; the JSON state contains the CSRF token, public session fields, and configured provider names. See the adopter's backend spec for a complete React integration.

The project is MIT licensed and hosted at [diffplug/pgstencil](https://github.com/diffplug/pgstencil). Public npm namespace, registry credentials, trusted publishing and release automation remain deferred. These local archives are ordinary npm package artifacts, so that later switch does not require submodules or a source-loader integration.

## Better Auth integration

New applications can use `@pgstencil/auth/better-auth` and the request-scoped
`@pgstencil/auth/better-auth-workers` adapter. The old exports remain available
so adoption can be staged without changing already deployed auth code.

```ts
import {
  createBetterAuthWorker,
  type BetterAuthWorkerBindings,
} from '@pgstencil/auth/better-auth-workers';
import { postmarkEmail } from '@pgstencil/auth/postmark';

type Env = BetterAuthWorkerBindings & {
  POSTMARK_SERVER_TOKEN: string;
  EMAIL_FROM: string;
};
const auth = createBetterAuthWorker<Env>({
  appName: 'Type The Rhythm',
  sessionPolicy: 'single', // Dormouse uses 'multiple'.
  accountLinking: 'same-email', // Default: 'explicit'.
  trustedEmailProviders: ['google', 'apple', 'facebook'], // Skip the extra mailbox code.
  allowMissingEmail: true, // Optional: provider-only accounts have public email: null.
  successPath: '/profile',
  errorPath: '/login',
  email: (env) => postmarkEmail(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM),
});
```

Supply an environment type extending `BetterAuthWorkerBindings` with the email
bindings used by your application. Forward `/api/auth/*` and `/api/providers` to
`auth.fetch(request, env, executionCtx)`. Bind `HYPERDRIVE`, `APP_ORIGIN`, and
`AUTH_SECRET`; paired provider credentials enable OAuth. A consumer can strip
provider bindings in its preview entry to guarantee email-only previews.

Use `betterAuthMigrations` from `@pgstencil/auth/better-auth-migrations`. These
reserve `public.user`, `session`, `account`, `verification`, `rateLimit`,
`pgstencil_auth_limits`, and `pgstencil_oauth_claims`. An existing deployment
retains its old migration source and adds this one; it must not drop checksum
history. Old and new auth tables coexist, but sessions/accounts are independent.

Node hosts use `createAuthApp({databaseUrl, origin, secret, email, ...})` and call
`close()` before returning their database lease. Tests bundle their application
with esbuild's `inject` set to the **actual module file** resolved from
`@pgstencil/auth/better-auth-testing`. Injecting a re-export shim does not work.
Use that module's `deterministicScope.run({time, random, outboundFetch}, action)`
for app creation and requests. Never inject it into production builds.

The [working example](examples/better-auth/README.md) documents the HTTP protocol,
security choices, native session-token storage tradeoff, test coverage and
provider callback registration. `packages:verify` also installs and exercises
this integration from the tarball alongside the legacy auth and Stripe packages.

### Account linking policies

`accountLinking: 'explicit'` (default) requires an authenticated Connect action
and permits different verified emails. `same-email` enables automatic matching
and makes POST `/api/auth/link-social` return 404, including for signed-in users.
Google always requests its account chooser. Existing provider bindings remain
stable if a provider later changes its email; policy changes do not unlink them.

By default, for a new identity in `same-email` mode, Apple and Google Gmail/Workspace can
establish mailbox ownership. Google third-party addresses, Facebook and GitHub
require a live email-OTP session for the same address, less than ten minutes old.
OAuth-only sessions cannot supply this proof. Unverified/missing provider email
still fails closed. `trustedEmailProviders` skips the extra email-OTP proof for the
listed providers. It trusts their verified email assertions (including Facebook’s
authenticated profile email) for both signup and automatic same-email linking.
Case-insensitive matching does not collapse aliases or relay
addresses. Apple Hide My Email therefore creates a separate account.

The fallback callback redirects to `errorPath` with
`error=email_verification_required&provider=google` (or the relevant provider).
Show an email-code form, verify that provider account's email with the normal
email-OTP API, then retry `/api/auth/sign-in/social` in that browser. Do not redirect
to Profile merely because this intermediate email login created a session. On
success, the native provider binding makes future OAuth logins code-free. Allow
cancelling the continuation to use ordinary email login instead. The server checks
the proof; query parameters grant no authority and contain no email or tokens.

With `allowMissingEmail: true`, a verified provider identity can sign up without
an email. Better Auth requires a non-null email column, so pgstencil uses an
unverified, provider/client/subject-specific address at `identity.pgstencil.invalid`.
HTTP session responses expose that address as `email: null`; email-code routes
and the email sender reject that namespace. Never use internal Better Auth user
emails as delivery addresses without checking them. No SQL migration is needed.
Existing bindings retain their account and canonical email if provider email
permission disappears. Provider-only accounts stay provider-only even if the
provider later supplies an email; adopting an address or merging existing accounts
requires a separate account-recovery flow. Without a common email or an existing
binding, different providers cannot be matched automatically.

`rememberLoginMethod: true` enables Better Auth's last-login-method plugin with
no database field. A successful login sets a readable 30-day cookie containing
only `email` or a provider ID. Failed attempts and explicit links do not update
it; logout retains it. The name is `__Host-pgstencil.last_login_method` on HTTPS
and `pgstencil.last_login_method` locally. This is an untrusted display hint,
never proof of identity or a replacement for a session. New browsers/private
windows and cleared cookies have no hint.

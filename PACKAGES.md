# Consuming pgstencil

Three packages share version 0.1.0: `pgstencil` (infrastructure and test primitives), `@pgstencil/auth` (email/OAuth/session services and a JSON HTTP adapter), and `@pgstencil/stripe` (SaaS billing and StripeDev). They are private workspace packages for now; no registry account is needed to consume their tarballs.

Run `pnpm packages:pack` to produce the three archives in `dist/packages`. They contain ESM JavaScript, TypeScript declarations, the MIT license, and required SQL/Compose assets. Workspace development uses source exports; packing switches the exports to compiled files. Nothing runs migrations during install.

Copy the tarballs to a consumer's `vendor/` directory, depend on them using `file:` paths, and override all three package names to those same paths in the consumer's pnpm configuration. The override for `pgstencil` ensures auth and billing's peer also resolves locally. `packages:pack` refuses a modified build input tree, because an untracked file under `migrations` would otherwise ship in the archive; `--allow-dirty` overrides that for a local experiment. Commit the archives and lockfile together for a reproducible temporary distribution. Once public npm is configured, replace these paths with exact registry versions and remove the overrides.

Every archive carries `package/dist/provenance.json`, holding the 40-character `commit` it was packed from plus `"dirty": true` when `--allow-dirty` packed a modified tree. Read it without unpacking the archive: `tar -xOf vendor/pgstencil-0.1.0.tgz package/dist/provenance.json`. That path is the contract; nothing else in the archive identifies its source, since npm's `gitHead` is absent from a `pnpm pack` of a private package. A consumer should record the commit it vendored, re-derive it from the archive on every build, and refuse an archive whose commit differs or that is marked dirty. `pnpm packages:verify` makes the same assertion against this checkout's `HEAD`, so a stale archive fails CI here. Having recovered the commit, a consumer confirms it was audited by reading its check run — `gh api repos/diffplug/pgstencil/commits/<sha>/check-runs` lists `security-audit`, which succeeds only when that commit's audit against [SECURITY.md](SECURITY.md) reached `VERDICT: PASS`.

`pnpm packages:verify` builds, packs, installs into an unrelated temporary pnpm project, checks TypeScript declarations, and runs an email login and required-card trial against a real cloned database. The project declares each peer at the version this workspace tests, and fails on an unmet peer. It shares this repository's Docker service state, but loads all code and SQL from installed archives. The consumer directory is printed for inspection.

## Dependencies

Applications declare pgstencil's peer dependencies themselves: `kysely` for every package, `hono` for `@pgstencil/auth`, and `stripe` for `@pgstencil/stripe`. Auth and billing also peer on the `pgstencil` released with them. A library is a peer when the application and pgstencil must share one copy. Either objects cross the boundary, or the library holds module-level state. Kysely and Hono classes have private fields, so two copies are incompatible types. `pgstencil/diagnostics` keeps its request scope in `AsyncLocalStorage`. The application's Renovate updates each shared library once, and pgstencil uses that copy. pnpm reports a release outside a peer range; pgstencil must widen the range first.

Every other dependency is private: pgstencil owns its version and applications do not import it. Better Auth is deliberately private. pgstencil imports its internal subpaths and tests login and linking rules against specific releases, so its range admits patches only. A new login provider or Better Auth plugin belongs in `@pgstencil/auth`, not in an application. Private ranges start at the version pgstencil's CI tested. [`.github/renovate.json`](.github/renovate.json) raises that floor, and re-vendoring carries it into each application.

## Application composition

Production imports use `pgstencil`, `pgstencil/postgres`, `@pgstencil/auth` and `@pgstencil/stripe`. Docker startup and test fixtures are opt-in imports through `pgstencil/database`, `pgstencil/testing`, and `@pgstencil/stripe/testing`.

The database tooling uses the current working directory as the project root, or `PGSTENCIL_PROJECT_ROOT` when explicitly set. State goes in that project's `.pgstencil`; its Docker Compose project name derives from the project path. A project can supply `compose.yaml`, otherwise the package's bundled default is used. The default SQL directory is `migrations`, overridable by a `pgstencil.json` file containing a `migrations` directory path inside the project root; a path resolving outside it is refused. Applications composing packages should pass their complete source list explicitly:

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
`close()` before returning their database lease. Serve `app.fetch` through
`@hono/node-server`, passing its `env` along: the socket in `env.incoming` is the
client IP that Better Auth's per-IP limiter and pgstencil's per-IP email budget
count, and any client-sent `x-pgstencil-client-ip` is overwritten. Behind a
reverse proxy, opt in with `ipAddressHeaders: ['x-real-ip']`, naming a
single-address header the proxy overwrites on every request; never name one a
client can set. A request with neither shares one bucket. The Workers adapter
always counts `cf-connecting-ip`. Stored limiter keys are HMACs under
`AUTH_SECRET`, never raw addresses. Tests bundle their application
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

The Better Auth integration also supports `microsoft` with `MICROSOFT_CLIENT_ID`
and `MICROSOFT_CLIENT_SECRET`. Its callback is `/api/auth/callback/microsoft`.
Personal and work/school accounts are supported; verified email can participate
in same-email linking. Unverified email does not establish an account match.
[Microsoft configuration and identity checks](examples/better-auth/README.md#microsoft)
include the optional ID-token claims needed for email matching.

## Structured diagnostics

`pgstencil/diagnostics` provides opt-in JSON diagnostics without a logging dependency.
Wrap your outer request handler with `observeRequest(request, { revision: buildSha },
async () => app.fetch(request, env, ctx))`. Node `createAuthApp` and the Better Auth
Workers adapter also accept `diagnostics: {}` when no outer wrapper is needed.
Nested wrappers reuse one server-generated UUID, returned in `X-Request-ID`.
Failed OAuth redirects include `request_id` for support; it grants no authority.

Auth records distinguish state validation, token exchange, key fetching, ID-token
and profile checks, login, logout, rejection and email delivery. Stripe records
verified webhook receipt, committed processing and failures, including the Stripe
event ID. For jobs and webhooks outside a request wrapper, use
`withDiagnostics(options, () => billing.handleWebhook(...))`. The database webhook
ledger remains the durable record; logs are diagnostic and may expire or be lost.

Only enumerated categories, bounded numbers, booleans and validated correlation
identifiers are emitted. No raw paths, query strings, request bodies, headers,
emails, tokens, SQL, error messages or stacks are serialized. Token-check flags
are untrusted diagnostic hints; they never change authentication decisions.
The default sink writes JSON to console. Cloudflare hosts should enable Workers
Logs, disable automatic invocation logs, and enable query-string redaction.
Other application/platform logging must be configured separately.

Tests can inject `sink`, `time: DevTime`, and `requestId`. AsyncLocalStorage isolates
concurrent requests; there are no global time patches. Logging sink failures are
ignored so they cannot change authentication or payment outcomes. Successful
static requests are omitted; API completions include status and elapsed time.

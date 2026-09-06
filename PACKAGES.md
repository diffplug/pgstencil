# Consuming pgstencil

Three packages share version 0.1.0: `pgstencil` (infrastructure and test primitives), `@pgstencil/auth` (email/OAuth/session services and a JSON HTTP adapter), and `@pgstencil/stripe` (SaaS billing and StripeDev). They are private workspace packages for now; no registry account is needed to consume their tarballs.

Run `pnpm packages:pack` to produce the three archives in `dist/packages`. They contain ESM JavaScript, TypeScript declarations, and required SQL/Compose assets. Workspace development uses source exports; packing switches the exports to compiled files. Nothing runs migrations during install.

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

Public npm namespace, license selection, registry credentials, trusted publishing and release automation remain deferred. These local archives are ordinary npm package artifacts, so that later switch does not require submodules or a source-loader integration.

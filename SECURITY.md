# pgstencil security

pgstencil ships `pgstencil`, `@pgstencil/auth` and `@pgstencil/stripe` as packed tarballs ([PACKAGES.md](PACKAGES.md)). This file states what the Better Auth integration in `@pgstencil/auth` and `pgstencil` itself guarantee to a consuming application, as conditions an auditor can check at one commit; each section ends with the tests that pin them. Bare names are under `packages/auth/src/`, `packages/auth/better-auth-migrations/` or `tests/`.

The application owns everything outside the packages: TLS and its origin gate, the CSP of its own pages, secret and credential storage, database provisioning, provider registration, and — only when it opts in with `ipAddressHeaders` — a proxy that overwrites those headers on every request. `@pgstencil/stripe` and the original code/link `Auth` exports carry no rules here yet.

## Sessions and cookies

- **FAIL IF** an HTTPS deployment's auth cookies lack `__Host-`, `Secure`, `HttpOnly`, `Path=/` or `SameSite=Lax`, or carry `Domain`; inspect `better-auth.ts` and `better-auth-security.ts`.
- **FAIL IF** a session token, a provider access/refresh/ID token or the internal `singleSession`/`emailAuthenticated` fields reach browser JSON, a stored session `token` authenticates without the server's cookie signature, or a bearer or API-key plugin is enabled; inspect `publicAuthResponse` and `plugins`.
- **FAIL IF** sessions outlive 24 hours, refresh on use, come from a cookie cache instead of the database, or session creation stops being serialized per user; inspect `session` in `better-auth.ts` and `002_security_policy.sql`.
- **FAIL IF** `sessionPolicy: 'single'` leaves another device signed in, `'multiple'` (the default) revokes one, or sign-out revokes another session; inspect `databaseHooks.session`.
- **FAIL IF** the readable `rememberLoginMethod` cookie grants authority, records a failed attempt or an explicit link, or is written to the database; inspect `lastLoginMethod` in `better-auth.ts`.

Pinned by `integration/better-auth.test.ts`: `email policy: secret-keyed codes, cross-browser redemption, concurrent single use and no token exposure`, `Better Auth time: 23 hours, expiration boundary, isolated async contexts and unchanged host clock`, `session policy: single`, `session policy: multiple`; `integration/better-auth-oauth.test.ts`: `Last login method remembers only successful sign-ins and survives logout`.

## CSRF and origin

- **FAIL IF** a state-changing POST is accepted without an exact `Origin` match, a signature-verified CSRF cookie, a matching `X-CSRF-Token` and an `application/json` body; inspect `protectAuth` in `better-auth-security.ts`.
- **FAIL IF** an upstream Better Auth route outside the read/write allowlist answers with anything but 404, or a provider callback accepts a method other than GET and Apple's `form_post` relay; inspect `protectAuth`.
- **FAIL IF** a response leaves without `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and a CSP denying framing, inline script and third-party sources; inspect `protectAuth`.
- **FAIL IF** the app accepts a non-canonical origin, a secret under 32 characters, or a success/error path off the application origin; inspect `authOptions` in `better-auth.ts`.

Pinned by `integration/better-auth.test.ts`: `auth surface: explicit CSRF, exact origin, security headers and disabled unused endpoints`, `auth surface: an allowlisted write with a non-JSON body answers 415`, `auth options reject a non-canonical origin, a short secret and off-origin redirect paths`, `Better Auth email rejects expired codes and cross-origin sign-in`; `integration/better-auth-oauth.test.ts`: `Better Auth OAuth: Apple form_post relay, wrong browser, mismatched provider and expired state`, `Better Auth OAuth: callbacks refuse every method but GET and Apple's form-encoded POST`.

## Email codes

- **FAIL IF** a stored email code is recoverable without the application secret, is not separated by purpose from other keyed values, lives longer than ten minutes, survives more than three failed guesses, or is redeemed twice; inspect `emailOTP` in `better-auth.ts` and `keyed` in `better-auth-security.ts`.
- **FAIL IF** a stored rate-limit key — Better Auth's `rateLimit` rows or pgstencil's `pgstencil_auth_limits` — contains a raw email address or IP instead of a secret-keyed HMAC, or a changing client IP resets an address's one-minute resend cooldown, five sends or fifteen verification attempts per fifteen minutes; inspect `rateLimitStorage` and `consume` in `better-auth-security.ts`, `rateLimit` in `better-auth.ts` and `005_hashed_rate_limit_keys.sql`.
- **FAIL IF** Better Auth's per-IP limiter or pgstencil's per-IP email budget counts any address but one trusted client IP — on Node the socket address `@hono/node-server` passes as `env.incoming`, or a forwarded header only when the application names it in `ipAddressHeaders` — or a client-supplied `x-pgstencil-client-ip` reaches either limiter; inspect `protectAuth` in `better-auth-security.ts` and `advanced.ipAddress` in `better-auth.ts`.
- **FAIL IF** the Workers adapter counts a client-IP header other than `cf-connecting-ip`, or an address in the reserved `identity.pgstencil.invalid` namespace reaches an email route or the email sender; inspect `better-auth-workers.ts` and `isIdentityEmail`.

Pinned by `integration/better-auth.test.ts`: `email policy: secret-keyed codes, cross-browser redemption, concurrent single use and no token exposure`, `email policy: distributed IPs cannot bypass cooldown, send quota or attempt budget`, `email policy: fifteen verification attempts per fifteen minutes stop even the right code from any IP`, `IP rate limits: stored limiter keys never contain a raw client IP`, `IP rate limits: the default Node path counts the socket, so rotating x-pgstencil-client-ip cannot escape`, `IP rate limits: concurrent requests from one address are counted atomically`, `IP rate limits: naming a victim's IP in x-pgstencil-client-ip spends only the caller's budget`, `IP rate limits: an explicit ipAddressHeaders opt-in counts the configured header`; `integration/better-auth-workers.test.ts`: `Better Auth in workerd: deterministic replay, separate clocks, shared database rate limits`; `integration/better-auth-oauth.test.ts`: `Optional email: <provider> signs in by stable identity without a mailbox`.

## OAuth

- **FAIL IF** a callback is processed without a signed browser-bound state cookie, an unexpired state row for the provider it names, and an atomic single-use claim taken in Postgres before the code exchange; inspect `oauthRequest` in `better-auth-oauth.ts` and `003_oauth_claims.sql`.
- **FAIL IF** a caller can choose the callback destination, the scopes or any OAuth parameter beyond the provider name, or can sign in by presenting a provider ID or access token directly; inspect `oauthRequest` and `protectAuth`.
- **FAIL IF** a Google, Apple or Microsoft ID token is accepted without signature, issuer, audience, expiry and nonce verification or under an algorithm other than RS256, a Microsoft identity is keyed on anything but a verified tenant and object ID, or GitHub signs in without a verified primary email; inspect `verifiedOidc`, `socialProviders` and `providerSubject` in `better-auth-email.ts`.
- **FAIL IF** a provider access, refresh or ID token survives identity verification in the database or a response; inspect `databaseHooks.account`.
- **FAIL IF** a provider's error description, or any provider error code outside the `errorCodes` allowlist in `packages/pgstencil/src/diagnostics.ts`, reaches a redirect URL, a page or a diagnostic record, or an allowlisted code reaches a redirect URL or a page; a diagnostic record may carry an allowlisted code as `errorCode` and Microsoft's bounded numeric `error_codes[0]` as `providerCode`, nothing else from the provider's error; inspect the callback redirect handling in `oauthRequest` and `diagnosticError`.

Pinned by `integration/better-auth-oauth.test.ts`: `Better Auth OAuth: <provider> login, safe token storage and callback replay`, `Better Auth OAuth: <provider> rejects invalid signed claims`, `Better Auth OAuth: <provider> rejects ID tokens whose header names an algorithm other than RS256`, `Better Auth OAuth: concurrent callbacks exchange once and errors contain no provider details`, `Better Auth OAuth: caller cannot override callback origin or use direct provider tokens`, `Microsoft tenant identity and unverified email cannot capture another account`; `integration/better-auth-workers.test.ts`: `Better Auth OAuth in workerd: <provider>`; `unit/diagnostics.test.ts`: `diagnostics allowlist drops secrets even in unexpected fields and malformed values`, `provider error extraction keeps numeric codes and tolerates hostile getters`.

## Account linking

- **FAIL IF** `accountLinking` defaults to anything but `'explicit'`, matching email addresses merge two identities under that default, or an explicit link starts without a session younger than ten minutes and a callback still carrying that same session; inspect `account.accountLinking` in `better-auth.ts` and `oauthRequest`.
- **FAIL IF** one provider identity ends up owned by two users, or an unverified or missing provider email establishes a match; inspect `validateUserInfo` in `better-auth.ts` and `account_provider_identity` in `002_security_policy.sql`.
- **FAIL IF** `accountLinking: 'same-email'` joins a non-authoritative provider email to an account without a live session for that same address that an email code created less than ten minutes earlier; inspect `validateUserInfo` and `004_email_session_proof.sql`.
- **FAIL IF** an `allowMissingEmail` provider-only account publishes its reserved address as an email, or a returning provider subject moves onto another account because the provider later supplied that account's address; inspect `socialProviders` and `identityEmail`.

Pinned by `integration/better-auth-oauth.test.ts`: `Better Auth OAuth: email collision requires explicit linking; linking binds to live session`, `Better Auth OAuth: missing/unverified email is rejected and provider identities cannot be stolen by linking`, `Same-email linking: <provider> requires a fresh email session for non-authoritative email`, `Same-email linking: wrong-email, OAuth-only, expired and revoked sessions cannot supply mailbox proof`, `Optional email: <provider> signs in by stable identity without a mailbox`.

## Diagnostics

- **FAIL IF** a diagnostic record carries anything outside the enumerated events, categories (error codes only from the `errorCodes` allowlist), bounded numbers, booleans and validated correlation identifiers — never an email, sign-in code, token, cookie, header, path, query string, SQL statement, error message, provider error description or stack; inspect `diagnostic` and `diagnosticError` in `packages/pgstencil/src/diagnostics.ts`.
- **FAIL IF** a failing or hostile sink changes a response, leaks exception text, or lets one request's context reach another's record; inspect `diagnostic` and `observeRequest`.
- **FAIL IF** a caller-supplied request ID is trusted, or an expected 4xx auth rejection is recorded as a server failure; inspect `observeRequest` and `onAPIError` in `better-auth.ts`.

Pinned by `unit/diagnostics.test.ts`: `diagnostics allowlist drops secrets even in unexpected fields and malformed values`, `concurrent request logs preserve their own context and do not log arbitrary routes`, `a broken sink never changes successful responses or reveals thrown exception text`, `provider error extraction keeps numeric codes and tolerates hostile getters`; `integration/better-auth-oauth.test.ts`: `auth diagnostics identify Microsoft token failures without recording credentials or identity`.

## Build and test isolation

- **FAIL IF** a normal build reaches `@pgstencil/auth/better-auth-testing`, or a deployed Worker answers a test clock route; inspect `examples/better-auth/src/worker.ts` beside `support/better-auth-worker.ts`, and the esbuild `inject` that only test bundles carry.
- **FAIL IF** Better Auth introspects or migrates the schema during a request, or the committed migrations stop matching Better Auth's generated plan; inspect `advanced.database` in `better-auth.ts` and `schemaChanges` in `examples/better-auth/src/schema.ts`.

Pinned by `integration/better-auth-workers.test.ts`: `normal Workers build uses real time and randomness and contains no test clock controls`; `integration/better-auth.test.ts`: `Better Auth email: repeatable cookies, database and email snapshots across parallel apps`.

## Packed provenance

- **FAIL IF** `packages:pack` builds from a modified `packages`, `scripts`, `tsconfig.json`, `tsconfig.build.json`, `pnpm-lock.yaml`, `compose.yaml`, `LICENSE` or `package.json` without `--allow-dirty`; inspect `scripts/build-packages.ts`.
- **FAIL IF** a tarball omits `package/dist/provenance.json` — the contract path a consumer reads out of the archive — that file omits the 40-character packing commit, or a pack of a modified tree is not marked `"dirty": true`; inspect `scripts/build-packages.ts` and [PACKAGES.md](PACKAGES.md).
- **FAIL IF** `packages:verify` accepts an installed package whose provenance commit is not this checkout's `HEAD`, or that is marked dirty; inspect `scripts/verify-packages.ts`.

Pinned by `pnpm packages:verify` in `.github/workflows/check.yml`.

## Continuous checks

- **FAIL IF** `.github/workflows/check.yml` stops running `db:verify`, `test:scripts`, `test` and `packages:verify` on pushes to `main` and on every pull request, drops `persist-credentials: false`, or grants any permission beyond `contents: read`; inspect `.github/workflows/check.yml`.
- **FAIL IF** `.github/workflows/security-audit.yml` is missing or disabled, loses its `push` to `main` trigger or its `security-audit` job name — a consumer reads that check run by name — lets the reporting step treat anything but an exact `VERDICT: PASS` line above a `<!-- END OF REPORT -->` sentinel as passing, or drops the step that redacts secrets from the report and the transcript; inspect `.github/workflows/security-audit.yml`.
- **FAIL IF** the audit job stops declaring `environment: security-audit`, that environment's deployment-branch policy admits any ref but `main` (`gh api repos/diffplug/pgstencil/environments/security-audit/deployment-branch-policies`), or the ruleset on `main` stops requiring a pull request or blocking force-push and deletion (`gh api repos/diffplug/pgstencil/rules/branches/main`); the environment is what keeps `CLAUDE_CODE_OAUTH_TOKEN` from a workflow pushed on any other branch.

Pinned by `pnpm test:scripts`, which runs the shipped reporting and redaction shell rather than a copy: `scripts/security-audit.test.mjs`.

## How this file is checked

`.github/workflows/security-audit.yml` executes this file nightly at 04:51 UTC, on demand, and on every push to `main`. One agent runs every `FAIL IF` above as a mechanical check, then reads the code behind them adversarially, following `.github/audit/_preamble.md` and `.github/audit/security.md`; `scripts/security-audit-local.sh` runs the same prompts against the same files locally. A run that does not reach an exact `VERDICT: PASS` files or appends to an open issue labelled `security-audit-failure` and exits non-zero, and a later pass closes it. Every run archives the report and the session transcript as the `audit-transcript` artifact — public, like this repository, and kept 14 days.

## Reporting a vulnerability

Report privately through GitHub's [advisory form for diffplug/pgstencil](https://github.com/diffplug/pgstencil/security/advisories/new); never a public issue. pgstencil is pre-1.0 and unpublished to npm, so a fix lands on `main` and reaches a consumer through a re-vendored tarball; there is no backport branch.

## What is not defended

- The consumer-owned controls listed above.
- An attacker holding both the database contents and `AUTH_SECRET`. Better Auth stores native session tokens, so that pair mints a session cookie; either alone does not.
- Better Auth behavior beyond what these tests pin; its private range admits patches only, and an upgrade must rerun the security and snapshot suites.
- A provider that asserts an email it did not verify, and account recovery after a lost provider account or mailbox.
- Multi-factor authentication and passkeys, and abuse beyond the budgets above.
- `@pgstencil/stripe`, the original code/link `Auth` exports, and the example applications; see [BILLING.md](BILLING.md), [OAUTH.md](OAUTH.md) and [LOGIN_FLOW.md](LOGIN_FLOW.md).

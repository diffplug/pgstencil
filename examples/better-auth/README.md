# Better Auth with pgstencil

Better Auth 1.7.3 handles email-code login and Google, Apple, Facebook and GitHub
OAuth. pgstencil owns SQL migrations, Docker/IntegreSQL clones, email capture,
security policy and deterministic tests. The reusable exports live in `@pgstencil/auth`; see [package consumption](../../PACKAGES.md#better-auth-integration). This example is isolated from the old
auth implementation and from TTR production.

With Docker running:

```sh
pnpm dev:better-auth
pnpm test:better-auth
```

Open `http://127.0.0.1:8082`, enter any test email and read its eight-digit code at
`/dev/emails`. Development uses real time/randomness and a disposable database.
`PORT=0` chooses a free port. Stop with Ctrl-C. OAuth buttons appear only for
configured providers; set paired `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
`APPLE_CLIENT_ID`/`APPLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET`
and/or `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` in the process environment.

## Security policy

- Codes work across browsers, last ten minutes, allow three failed guesses and
  use purpose-separated HMAC-SHA256 storage with the application secret.
- Atomic Postgres counters enforce a one-minute per-email resend cooldown,
  five sends and fifteen verification submissions per email per fifteen minutes,
  plus IP budgets and Better Auth's stricter short-window IP limits. Counter
  keys contain keyed hashes rather than raw emails/IPs; expired counters are pruned.
- Each browser obtains `GET /api/auth/csrf`, then supplies `X-CSRF-Token` on
  same-origin JSON POSTs. The matching HttpOnly cookie is signed. HTTPS cookies
  use `__Host-` names, Secure, HttpOnly, Path=/ and SameSite=Lax.
- Only the implemented API operations are exposed. Responses omit upstream
  session tokens, use no-store, and have security headers. CSP permits the local
  external script; it does not require unsafe-inline.
- `sessionPolicy: 'single'` signs out all other devices on successful login (TTR).
  `'multiple'` is the default and retains independent sessions (Dormouse).
  A Postgres trigger serializes session creation per user. Logout revokes the
  current session. Sessions last 24 hours with refresh and cookie caching disabled.
- Better Auth stores native session tokens in the database. A token alone cannot
  authenticate: the cookie also needs the server signature, and no bearer plugin
  is enabled. Browser JSON omits these tokens. This is an explicit upstream storage
  tradeoff; the test suite proves a bare database token is rejected.
- The default `accountLinking: 'explicit'` policy never merges OAuth identities just because their email addresses match. Sign in
  by email or an existing provider, then explicitly connect another provider.
  Connecting requires a session less than ten minutes old, and the callback must
  still carry that same live session. Different verified provider emails are allowed,
  including Apple's private relay address. An identity cannot belong to two users.
  Consumers can choose automatic `same-email` linking with an email-code fallback;
  see [the policy and continuation protocol](../../PACKAGES.md#account-linking-policies).
- Callbacks check provider, signed browser state, expiry and an atomic Postgres
  replay claim. Apple form_post relays to a GET that receives the Lax cookies.
  Callback destinations are fixed to the application origin. Direct provider-token
  sign-in and unused upstream auth endpoints are unavailable.
- The pinned version's Google/Apple redirect profile readers only decode ID tokens.
  `verifiedOidc` explicitly enables Better Auth's signature/issuer/audience/expiry/
  nonce verification through its plugin API. Negative tests cover each check.
  GitHub requires a verified primary email; Facebook uses the authenticated email
  after Better Auth validates that the access token belongs to our app and user.
- Provider access, refresh and ID tokens are discarded after identity verification.
  They are not kept in the database or returned to the browser.

## Determinism and Workers

Test bundles inject the actual `@pgstencil/auth/better-auth-testing` module file with esbuild. Date, Web Crypto
and outbound fetch facades use AsyncLocalStorage to select each app's clock,
random stream and local provider server. They do not replace process globals,
cryptographic hashing/signing or timers. Normal builds have no injection or test
clock routes. Repeatable email/OAuth cookies, sessions and timestamps are tested
across parallel apps; all four providers also run through real workerd.

This adapter covers these APIs in the bundled dependency graph. Dependency
upgrades must rerun security and snapshot tests. The same request order is
repeatable; concurrent requests within one app need not have deterministic order.
Better Auth accepts a replayed session cookie at exactly 24 hours and rejects it
one millisecond later. Tests explicitly replay historical cookies independently
of the browser clock.

SQL is generated for review and committed, never migrated during requests.
Background runtime schema inspection is disabled because it races request-scoped
Worker pool teardown. Tests verify the committed schema against Better Auth's
migration plan. The Worker uses a Hyperdrive binding and an EMAIL service binding;
tests replace EMAIL with in-memory capture. Hosted Hyperdrive/Neon and real provider
configuration still need the first candidate-deployment smoke test.

## First production smoke test

Register these callback URLs with each enabled provider, using the candidate's
stable public origin:

| Provider | Callback                                      |
| -------- | --------------------------------------------- |
| Google   | `https://<origin>/api/auth/callback/google`   |
| Apple    | `https://<origin>/api/auth/callback/apple`    |
| Facebook | `https://<origin>/api/auth/callback/facebook` |
| GitHub   | `https://<origin>/api/auth/callback/github`   |

Existing Supabase client IDs/secrets can be reused when the provider configuration
allows the new callback. Apple uses a Services ID and an unexpired client-secret
JWT; its private relay also requires the mail sender to be registered with Apple.
Enter secrets directly into deployment tooling, not chat, source files or logs.
Do not delete Supabase/Pages until email and each required provider pass in a real
browser. The TTR test must also confirm that a second device's login signs out
the first, and that its chosen linking policy preserves account IDs across login methods.

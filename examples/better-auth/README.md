# Better Auth with pgstencil

[Better Auth](https://better-auth.com), pinned by `@pgstencil/auth` to the exact release its CI tested, handles email-code login and Google, Apple, Facebook, GitHub and Microsoft
OAuth. pgstencil owns SQL migrations, Docker/IntegreSQL clones, email capture,
security policy and deterministic tests. The reusable exports live in `@pgstencil/auth`; see [package consumption](../../PACKAGES.md#better-auth-integration).

With Docker running:

```sh
pnpm dev
pnpm test
```

Open `http://127.0.0.1:8082`, enter any test email and read its eight-digit code at
`/dev/emails`. Development uses real time, a fresh random seed (override it with
`PGSTENCIL_SEED`) and the persistent `pgstencil_dev` database, migrated from
`src/migrations.ts` on start; `pnpm db:reset` recreates it.
`PORT=0` chooses a free port. Stop with Ctrl-C. OAuth buttons appear only for
configured providers; set paired `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
`APPLE_CLIENT_ID`/`APPLE_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` and/or `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`
in the process environment or `.env`.

## Billing demo

`createEmailApp({ ..., billing: { stripe, config, time, random } })` adds a
card-required trial on `@pgstencil/stripe`; without `billing` the example only
signs in. The billing owner is the signed-in user's ID. `pnpm dev` runs it
against the local StripeDev simulator, whose state persists in
`.pgstencil/stripe-dev.json` and whose webhooks go to this server. `/billing` is
a small page over these JSON routes:

| Route                               | Result                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/billing`                  | Ensures the account, confirms `?checkout=<operation>` or reconciles; status |
| `POST /api/billing/checkout`        | `{ "plan": "monthly" }` → `{ "url" }` of a Checkout Session                 |
| `POST /api/billing/portal`          | `{ "url" }` of a billing portal session                                     |
| `POST /api/billing/cancel-checkout` | Expires the open Checkout; status                                           |
| `POST /api/stripe/webhook`          | Raw signed body and `stripe-signature`; 200, or a `BillingError`'s status   |

Every route except the webhook needs a live session (401 otherwise). The POSTs
also need `Origin` to equal the application origin exactly (403) and
`content-type: application/json` (415). An unknown plan is 400 and a checkout
operation the user does not own is 404. The server chooses the customer, prices
and return URLs; only the plan name is read from a request body. Checkout gets
the user's email only when it is verified, so a provider-only account's
internal address never reaches Stripe.

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
- `sessionPolicy: 'single'` signs out all other devices on successful login.
  `'multiple'` is the default and retains independent sessions.
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
  Consumers can choose automatic `same-email` linking and trust selected providers’
  emails without an extra code; the conservative default keeps an email-code fallback;
  see [the policy and continuation protocol](../../PACKAGES.md#account-linking-policies).
- Callbacks check provider, signed browser state, expiry and an atomic Postgres
  replay claim. Apple form_post relays to a GET that receives the Lax cookies.
  Callback destinations are fixed to the application origin. Direct provider-token
  sign-in and unused upstream auth endpoints are unavailable.
- The pinned version's Google/Apple/Microsoft redirect profile readers only decode ID tokens.
  `verifiedOidc` explicitly enables Better Auth's signature/issuer/audience/expiry/
  nonce verification through its plugin API. Negative tests cover each check.
  GitHub requires a verified primary email; Facebook uses the authenticated email
  after Better Auth validates that the access token belongs to our app and user.
- `allowMissingEmail` optionally permits provider-only accounts. Public sessions
  expose `email: null`; the reserved internal address cannot receive login codes.
  See [package policy options](../../PACKAGES.md#better-auth-integration) for matching and recovery limits.
- Provider access, refresh and ID tokens are discarded after identity verification.
  They are not kept in the database or returned to the browser.

## Determinism and Workers

Test bundles inject the actual `@pgstencil/auth/better-auth-testing` module file with esbuild. Date, Web Crypto
and outbound fetch facades use AsyncLocalStorage to select each app's clock,
random stream and local provider server. They do not replace process globals,
cryptographic hashing/signing or timers. Normal builds have no injection or test
clock routes. Repeatable email/OAuth cookies, sessions and timestamps are tested
across parallel apps; all five providers also run through real workerd.

This adapter covers these APIs in the bundled dependency graph. Dependency
upgrades must rerun security and snapshot tests. The same request order is
repeatable; concurrent requests within one app need not have deterministic order.
Better Auth accepts a replayed session cookie at exactly 24 hours and rejects it
one millisecond later. Tests explicitly replay historical cookies independently
of the browser clock.

`src/worker.ts` sends email through an `EMAIL` service binding, which the Workers
tests replace. `src/postmark-worker.ts` is the deployable entry in `wrangler.jsonc`,
sending through Postmark with `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM`;
`pnpm --filter @pgstencil/example-better-auth build` bundles it with
`wrangler deploy --dry-run`. Replace the placeholder origin and Hyperdrive ID before deploying.

SQL is generated for review and committed, never migrated during requests.
Background runtime schema inspection is disabled because it races request-scoped
Worker pool teardown. Tests verify the committed schema against Better Auth's
migration plan. The Worker uses a Hyperdrive binding and an EMAIL service binding;
tests replace EMAIL with in-memory capture. Hosted Hyperdrive/Neon and real provider
configuration still need the first candidate-deployment smoke test.

## Provider registration

Each provider needs both of its `*_CLIENT_ID` and `*_CLIENT_SECRET` values; a
provider with neither is disabled, and one with only half fails startup without
printing secrets. Register the exact callback, including scheme, hostname and
port: `localhost` and `127.0.0.1` are different origins. Use separate
registrations for local and deployed environments.

| Provider  | Callback                                       |
| --------- | ---------------------------------------------- |
| Google    | `https://<origin>/api/auth/callback/google`    |
| Apple     | `https://<origin>/api/auth/callback/apple`     |
| Facebook  | `https://<origin>/api/auth/callback/facebook`  |
| GitHub    | `https://<origin>/api/auth/callback/github`    |
| Microsoft | `https://<origin>/api/auth/callback/microsoft` |

- **Google**: create a **Web application** OAuth client, configure the consent
  screen and any test users, and add the callback under authorized redirect URIs.
- **GitHub**: create an **OAuth App** with the callback as its authorization
  callback URL. The verified primary email is read from the authenticated
  email API, so it can be private.
- **Apple**: configure a web Services ID with the callback as its return URL.
  `APPLE_CLIENT_ID` is that Services ID; `APPLE_CLIENT_SECRET` is an ES256 JWT
  signed with your Apple key, which expires after at most six months and must be
  replaced before then. Apple's web flow needs a registered HTTPS domain, not a
  localhost URL. Register your sending domain with Apple's private email relay
  if users may choose Hide My Email.
- **Facebook**: enable Facebook Login for the Meta app and request `email`. An
  app in development mode only admits its own test accounts and roles.
- **Microsoft**: see [Microsoft](#microsoft) below.

For local OAuth, copy `.env.example` to `.env` at the repository root, fill in
the providers you want, and keep `PORT` fixed so the origin you registered is
the one `pnpm dev` binds.

## First production smoke test

Automated tests use local provider fixtures. They cannot establish that a
dashboard registration, a consent screen, real email delivery or a deployed
TLS/proxy path is correct. Before relying on a deployment, complete email
sign-in and each enabled provider's sign-in, cancellation, account connection
and sign-out in a real browser against the registered origin. Check that the
session policy you chose behaves as intended across two devices, and that the
linking policy keeps one account ID across sign-in methods. Enter secrets
directly into deployment tooling, never into chat, source files or logs.

## Microsoft

The Better Auth adapter supports personal and work/school Microsoft accounts at
`https://login.microsoftonline.com/common`. Configure `MICROSOFT_CLIENT_ID` and
`MICROSOFT_CLIENT_SECRET`, with a Web redirect URI of
`https://<origin>/api/auth/callback/microsoft`. It requests only OpenID, profile,
and email scopes; there is no Graph photo request or offline access.

Signatures, audience, expiration, nonce and the tenant-specific issuer are checked
before reading claims. Stable identities include both `tid` and `oid`.
An email can join an existing account only with `email_verified: true`,
`xms_edov: true`, or membership in the verified email claims. Ordinary `email`
and `preferred_username` are insufficient. Request `email` and `xms_edov` as
optional ID-token claims in the app registration. With `allowMissingEmail`,
missing/unverified email becomes a provider-only account without a code prompt.
`trustedEmailProviders: ['microsoft']` bypasses the additional local mailbox proof
only after these Microsoft-specific verification checks pass.

See [Microsoft's claim reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference)
and [Better Auth's provider setup](https://better-auth.com/docs/authentication/microsoft).

Microsoft signing keys are loaded with JOSE's remote JWKS resolver because
Microsoft's public RSA keys omit the optional `alg` member. Better Auth's
Microsoft key importer required that member and otherwise threw when this was written. pgstencil pins
RS256 and the Microsoft key endpoint, retaining signature, nonce, audience, issuer,
expiry and tenant/object identity checks. Local Microsoft fixtures also omit `alg`
so this production key shape is exercised in Node and Workers tests.

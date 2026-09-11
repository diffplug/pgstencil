# Hono and Cloudflare Workers

For new authentication integrations, use `@pgstencil/auth/better-auth-workers`.
[The package recipe](PACKAGES.md#better-auth-integration) covers Hono composition,
Postmark, SQL migrations, session policies and deterministic test bundles.
[The Better Auth example](examples/better-auth/README.md) documents the email and
OAuth protocol plus production acceptance checks.

The adapter below is the original implementation, retained for staged upgrades.

`@pgstencil/auth/fetch` owns the JSON routes, cookies and CSRF checks.
`@pgstencil/auth/hono` mounts that adapter in Hono; the existing `/http` export
bridges the same adapter to Node. `@pgstencil/auth/workers` composes a Hono app
with a request-scoped Kysely/pg connection through Hyperdrive. Connections close
in `finally`, including errors. Docker, migrations and snapshot lenses remain
Node-side tools and are excluded from the Worker bundle.

See [the deployable example](examples/workers/src/index.ts) and its
[Wrangler configuration](examples/workers/wrangler.jsonc). Build without uploading:

```sh
pnpm --filter @pgstencil/example-workers build
pnpm test tests/integration/workers.test.ts
```

The runtime tests execute bundled Hono/auth code inside workerd, with real
Postgres clones via local Hyperdrive bindings. EmailDev and OAuth HTTP fixtures
replace external services. They cover email login, exact 23/24-hour session
boundaries, Secure cookies, CSRF, Google/Apple/Facebook callbacks, browser binding
and replay. Node provider tests additionally verify signatures, claims, nonces,
PKCE where supported, provider failures and missing email. Test clock controls
exist only in the test entrypoint, never the deployable Worker.

## Deployment preparation

1. Provision an empty hosted Postgres database. Hyperdrive supplies pooling,
   not database storage. Apply the auth SQL migrations from Node using the direct
   database URL; migrations must finish before the new Worker serves traffic.
2. Create Hyperdrive with **query caching disabled** and replace the placeholder
   ID. Auth reads must immediately observe challenges, sessions and revocations.
   Local Hyperdrive tests don't reproduce Cloudflare's remote pool or cache.
3. Set `APP_ORIGIN` to the exact HTTPS frontend origin and `EMAIL_FROM` to a
   verified sending address. Mount the Worker on that same origin's `/api/auth/*`,
   `/oauth/*` and `/login/link` paths; serve the SPA elsewhere. No cross-origin
   auth or CORS credentials are needed.
4. Store `AUTH_SECRET` (at least 32 random characters), `POSTMARK_SERVER_TOKEN`,
   and each provider's `*_CLIENT_ID` / `*_CLIENT_SECRET` as Wrangler secrets.
   Apple needs a signed client-secret JWT, not a plain password. See [OAuth setup](OAUTH.md).
5. Register the exact HTTPS callbacks, deploy, then verify real email delivery
   and each provider's consent/callback flow in a browser. Automated mocks cannot
   establish that dashboard configuration or actual delivery is correct.

The example deliberately contains placeholder domain and Hyperdrive settings;
building it does not deploy anything. Secret files (`.env*`, `.dev.vars*`) and
Wrangler state are ignored. Avoid logging callback queries, cookies, email codes
or provider tokens. Cloudflare supplies the trusted `CF-Connecting-IP` header
used by the shared database rate limiter.

Hyperdrive [does not support advisory locks](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/).
Runtime auth and Stripe serialization uses row locks; SQL migration tooling runs
directly against Postgres. OAuth first-use identity creation locks one of 64
fixed rows, so arbitrary identities cannot grow a lock table without bound.

Stripe webhook verification is asynchronous and uses Web Crypto. On Workers,
construct the Stripe SDK with `httpClient: Stripe.createFetchHttpClient()` and
`await billing.webhook(rawBody, signature)`. `verifyWebhook()` is now asynchronous
too. The runnable Workers example currently covers authentication; billing retains
its independent Node integration suite.

For deployment details, use Cloudflare's [Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/get-started/)
and [query caching documentation](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

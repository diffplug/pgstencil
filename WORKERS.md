# Hono and Cloudflare Workers

`@pgstencil/auth/better-auth-workers` exports `createBetterAuthWorker`, a Hono
application that builds the auth app for each request from that request's
bindings: a Kysely/`pg` pool over the `HYPERDRIVE` connection string, opened and
closed inside the request, including on errors. No socket, clock or test control
crosses invocations. [The package recipe](PACKAGES.md#better-auth-integration)
covers its options, and [the example](examples/better-auth/README.md) the HTTP
protocol and provider registration. Docker, migrations, the CLI and snapshot
lenses remain Node-side tools and are excluded from a Worker bundle.

See [the deployable entry](examples/better-auth/src/postmark-worker.ts) and its
[Wrangler configuration](examples/better-auth/wrangler.jsonc). Build without
uploading, and run the workerd tests:

```sh
pnpm --filter @pgstencil/example-better-auth build
pnpm test tests/integration/better-auth-workers.test.ts tests/integration/billing-workers.test.ts
```

The runtime tests execute the bundled application inside workerd, with real
Postgres clones through local Hyperdrive bindings. EmailDev and local OAuth
provider fixtures replace external services. They cover email sign-in,
deterministic replay, separate clocks per application, rate limits shared through
the database, safe 503s when setup fails, and every OAuth provider. Test clock
controls exist only in the test entrypoint; a test proves the normal build uses
real time and randomness and contains none.

## Deployment preparation

1. Provision an empty hosted Postgres database. Hyperdrive supplies pooling,
   not database storage. Apply the SQL migrations from Node with
   `DATABASE_URL=<direct url> pnpm exec pgstencil migrate`; migrations must
   finish before the new Worker serves traffic.
2. Create Hyperdrive with **query caching disabled** and replace the placeholder
   ID. Auth reads must immediately observe codes, sessions and revocations.
   Local Hyperdrive tests don't reproduce Cloudflare's remote pool or cache.
3. Set `APP_ORIGIN` to the exact HTTPS frontend origin and `EMAIL_FROM` to a
   verified sending address. Route that same origin's `/api/auth/*` and
   `/api/providers` to the Worker; serve the frontend elsewhere. No cross-origin
   auth or CORS credentials are needed.
4. Store `AUTH_SECRET` (at least 32 random characters), `POSTMARK_SERVER_TOKEN`,
   and each provider's `*_CLIENT_ID` / `*_CLIENT_SECRET` as Wrangler secrets.
   Apple needs a signed client-secret JWT, not a plain password; see
   [provider registration](examples/better-auth/README.md#provider-registration).
5. Register the exact HTTPS callbacks, deploy, then verify real email delivery
   and each provider's consent/callback flow in a browser. Automated fixtures
   cannot establish that dashboard configuration or actual delivery is correct.

The example deliberately contains placeholder domain and Hyperdrive settings;
building it does not deploy anything. Secret files (`.env*`, `.dev.vars*`) and
Wrangler state are ignored. Avoid logging callback queries, cookies, email codes
or provider tokens. Cloudflare supplies the trusted `CF-Connecting-IP` header
that the adapter always counts for rate limits.

Hyperdrive [does not support advisory locks](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/).
Runtime auth and Stripe serialization uses row locks and atomic upserts; SQL
migration tooling, which does take advisory locks, runs directly against
Postgres.

## Billing on Workers

Stripe webhook verification is asynchronous and uses Web Crypto. On Workers,
construct the Stripe SDK with `httpClient: Stripe.createFetchHttpClient()` and
`await billing.webhook(rawBody, signature)`. `tests/integration/billing-workers.test.ts`
runs billing in workerd with the fetch client, Web Crypto webhook verification
and Hyperdrive. No billing code needs a Node-only API at runtime;
`@pgstencil/stripe/testing` and `/migrations` are Node-side.

For deployment details, use Cloudflare's [Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/get-started/)
and [query caching documentation](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

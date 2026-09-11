# Better Auth email experiment

Better Auth 1.7.3 owns email OTP login, sessions, cookies and database rate limits.
pgstencil still owns versioned SQL, Docker/IntegreSQL clones, EmailDev and snapshots.
This is an isolated experiment; TTR and the existing auth package are unchanged.

With Docker running, use `pnpm dev:better-auth` from the repository root and open
`http://127.0.0.1:8082`. Enter any test email; read the eight-digit code at
`/dev/emails`, then sign in. This demo uses real time and randomness. `PORT=0`
chooses a free port. Each run leases a disposable database, so it does not touch
the original example's development database. Stop it with Ctrl-C.

`pnpm test:better-auth` runs the Node and workerd experiments. Tests start
independent HTTP servers and databases. The normal Workers entry uses an EMAIL
service binding for delivery and creates/closes its database pool per request.
No real email provider, Cloudflare credentials or hosted database is needed.

The test build injects `tests/support/scoped-globals.ts` using esbuild. Its Date
and Web Crypto facades use AsyncLocalStorage to choose each application's
DevTime and DevRandom. It does not replace process globals, timers, cryptographic
hashing or signing. Normal builds do not inject it. This is a build adapter,
not a Better Auth fork or a public Better Auth clock API. Dependency upgrades
must pass the behavioral tests again, especially byte-for-byte snapshot replay.

The initial tests prove repeatable email codes, session IDs/tokens, cookie
signatures and database timestamps across concurrent applications, plus independent
historical clocks and real timers. Better Auth checks `expiresAt < now`: the
server accepts an explicitly replayed cookie at exactly 24 hours and rejects it
one millisecond later. Session refresh and cookie caching are disabled here.
OTP lifetime is ten minutes, with three attempts and hashed storage.

SQL was generated through Better Auth's migration API against an empty clone,
then committed for pgstencil to apply. Runtime code never runs migrations.
Origin/CSRF checks are explicitly enabled even under `NODE_ENV=test`.
Rate limits use Postgres because Worker instances cannot share process memory.
Workers trust Cloudflare's `CF-Connecting-IP`; the local Node listener derives
the address from the socket and overwrites the internal IP header.

The workerd tests also prove identical sessions and cookies across independent
isolates, time travel without expiring another app, and rate limits surviving
per-request auth instances. A separate build without injection proves real
timestamps, fresh session randomness, logout and absence of test controls.

## Result and remaining work

Email auth and deterministic testing work without changing Better Auth's source.
The application switches from a combined code/link challenge to Better Auth's
email-code flow. Cookies use Max-Age rather than an explicit Expires timestamp;
tests replay historical cookies explicitly so the browser clock is irrelevant.

The deterministic adapter is currently test infrastructure, not a published
pgstencil API. It intercepts Date and Web Crypto in the bundled dependency graph;
future code that uses other time/random APIs needs new coverage. Replaying the
same request order is deterministic; competing requests within one app are not
promised a deterministic scheduling order. Hashing, signing and network timers
remain real. Keep the dependency pinned and verify snapshots when upgrading.

Next: decide whether the one-millisecond expiry boundary matters, then adopt the
email integration in TTR and exercise its candidate deployment through real
Hyperdrive/Neon/Postmark. Local workerd tests do not validate Cloudflare's hosted
pooler. OAuth, linking policy, TTR migration and legacy-service deletion are
outside this experiment.

## Security policy

Email codes deliberately work across browsers. Each browser obtains its own
`GET /api/auth/csrf` token and sends it in `X-CSRF-Token` on same-origin JSON
POSTs. The matching HttpOnly cookie is signed. HTTPS cookies use `__Host-` names.
The API permits only the operations implemented by this example. Browser API
responses omit upstream session tokens; pages and API responses are not cacheable.
Scripts are external so CSP does not need `unsafe-inline`.

OTP storage uses purpose-separated HMAC-SHA256 with the application secret.
Atomic Postgres counters add a one-minute per-email resend cooldown, five sends
per fifteen minutes, and fifteen verification submissions per fifteen minutes,
on top of Better Auth's IP limits and three-attempt code budget. Counter keys
contain keyed email hashes rather than email addresses.

`sessionPolicy: 'single'` signs out all other devices on successful login (TTR).
`'multiple'` is the default and retains independent device sessions (Dormouse).
A Postgres trigger locks the user row and replaces sessions within the inserting
transaction, so concurrent Workers cannot leave two active single-policy sessions.
Logout revokes the current session.

Better Auth's native database still contains session tokens. Browser authentication
requires the server-signed cookie, and the test suite checks that a database token
alone cannot authenticate. We deliberately retain the upstream session storage
model instead of adding a custom adapter; no bearer-token plugin is enabled.
The deterministic adapter remains exclusively in test builds.

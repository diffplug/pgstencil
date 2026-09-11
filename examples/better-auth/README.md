# Better Auth email experiment

Better Auth 1.7.3 owns email OTP login, sessions, cookies and database rate limits.
pgstencil still owns versioned SQL, Docker/IntegreSQL clones, EmailDev and snapshots.
This is an isolated experiment; TTR and the existing auth package are unchanged.

Run `pnpm exec vitest run tests/integration/better-auth.test.ts` from the repository
root with Docker running. Tests start independent HTTP servers and databases.

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

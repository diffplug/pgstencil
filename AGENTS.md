This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.

# Working in pgstencil

pgstencil is three npm packages (`packages/pgstencil`, `packages/auth`, `packages/stripe`), one example application (`examples/better-auth`) and the tests that pin them. README.md explains the recipe, PACKAGES.md the public API and release process, BILLING.md billing, WORKERS.md the Workers adapter, SECURITY.md every guarantee and the test that pins it, and CHANGELOG.md what changed.

## Commands

Docker must be running; nothing else needs preparing.

- `pnpm check`: formatting, typecheck, script tests and the whole suite. Run it before calling work done.
- `pnpm test <file>`: one file. The whole suite takes about 20 seconds.
- `pnpm snapshot:update <file>`: the only way snapshots are rewritten. Read the resulting diff.
- `pnpm db:verify`: the committed schema dump and generated types still match the migrations. Rerun `pnpm db:schema` and `pnpm db:types` after touching SQL.
- `pnpm packages:verify`: packs the tarballs and exercises them from an unrelated project. It refuses a modified tree, so commit first.
- `pnpm dev`: the example with a local inbox and Stripe simulator.
- `pnpm db:migration:create <name> --in <dir>`: a new numbered SQL file. Name the package's directory with `--in`; the default is the last source in `pgstencil.json`.

## Rules that are easy to break

- Applied SQL is immutable. Never edit, rename or delete a migration file that has shipped; add a new numbered file. Deployed databases validate every applied file by checksum.
- A change to anything SECURITY.md describes needs its `FAIL IF` rule and pinning test updated in the same change. Tests are cited there by name, so renaming a cited test breaks the audit.
- Time and randomness are injected (`Time`, `RandomSource`), never read from globals, in code that takes them. Better Auth cannot take them, so its tests run a bundle built with `@pgstencil/auth/better-auth-testing`; that module must never reach a production bundle.
- Tooling dependencies (`testcontainers`, `node-pg-migrate`, `cheerio`, `turndown`, `kysely-codegen`) are optional peers loaded dynamically. No runtime entry point may import them statically; `scripts/runtime-deps.test.mjs` enforces it.
- Better Auth is pinned to an exact version because the integration reads its internals. Treat every bump as a change to review, and rerun the auth suites.
- The packages are libraries for other applications. Describe consumers generically in code and docs, and record every breaking change, with how to adapt, under Unreleased in CHANGELOG.md.
- Node is pinned in the root `package.json`'s `devEngines.runtime`; pnpm and CI both read it. Change it there and nowhere else.
- A release is a pull request that raises `version` in all three packages; merging one stages a publish. Do not bump versions for any other reason.

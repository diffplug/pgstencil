# Domain: security

**Scope — this file, and no other:**

- `SECURITY.md`

**Output file:** `audit-report.md`

This is a code-and-policy audit of what the packed packages guarantee to a
consuming application. Everything `SECURITY.md` assigns to the application —
TLS, the origin gate, page CSP, secret storage, database provisioning, provider
registration — is out of scope; so are `@pgstencil/stripe` and the original
code/link `Auth` exports, which carry no rules yet.

## Mechanical pass

Run every `FAIL IF` in `SECURITY.md`. Most of them are pinned by a named test,
so start by running the suites and reading their assertions, then read the code
each bullet names.

```sh
pnpm db:verify          # migrations apply and match the committed schema
pnpm test:unit          # diagnostics allowlist and the other unit rules
pnpm test:better-auth   # the session, CSRF, email-code, OAuth and linking suites
pnpm packages:verify    # packs, installs into a clean project, checks provenance
```

`test:better-auth` and `packages:verify` need a working Docker daemon (see
`compose.yaml`). If the daemon is unreachable, every check those suites pin is
`UNVERIFIABLE` — say so and say why. **Never record a check as PASS on the
strength of a test you did not run**, and never quietly skip one.

Each `Pinned by` line at the end of a `SECURITY.md` section names the tests for
that section. Confirm each named test still exists and still asserts what the
bullet claims: a test that was renamed, skipped, or reduced to a smoke check
leaves its bullet unenforced, and that is a finding even when the code is fine.

The remaining bullets are read rather than run:

- The `Continuous checks` bullets are grep-and-read over
  `.github/workflows/check.yml` and `.github/workflows/security-audit.yml`.
  Check the triggers, the job names, `persist-credentials: false`, the
  permission blocks, the reporting step's verdict grammar, and that the
  redaction step is present and covers every file the archive step publishes.
- The `Packed provenance` bullets are read over `scripts/build-packages.ts`,
  `scripts/pack-packages.ts` and `scripts/verify-packages.ts`, with
  `pnpm packages:verify` as the evidence.

## Qualitative pass

Be adversarial, and go past the `FAIL IF` list. Read
`packages/auth/src/better-auth*.ts`, `packages/pgstencil/src/*.ts`, and the
suites under `tests/` — including what they do _not_ cover. Ask at least:

- **Can a caller influence where an OAuth callback lands, or reuse state across
  applications?** Trace `oauthRequest` in `better-auth-oauth.ts` from the start
  of the flow through the signed state cookie, the `oauth_flows` row, and the
  atomic claim in `003_oauth_claims.sql`. Every parameter beyond the provider
  name must come from server configuration; a state row must bind the browser,
  the provider, and one application.
- **Does `verifiedOidc` cover every enabled provider?** Compare the providers in
  `socialProviders` against the ones `verifiedOidc` and `providerSubject` in
  `better-auth-email.ts` actually verify. A provider that is enabled but falls
  through the verification switch signs users in on an unverified assertion.
- **Can a real user register an address in the `identity.pgstencil.invalid`
  namespace?** Trace every writer of a user email — sign-up, linking,
  `allowMissingEmail` account creation, and any profile update — against
  `isIdentityEmail`. A reserved namespace that is only filtered on the way out
  is not reserved.
- **Can a raw upstream error carrying a token reach diagnostics?** Follow a
  provider or database error from where it is thrown to `diagnostic` and
  `diagnosticError` in `packages/pgstencil/src/diagnostics.ts`, and to
  `onAPIError`. Look for a path that stringifies an exception, a response body,
  or a URL with a query string.
- **Is any rate-limit key derivable without the application secret?** Read
  `keyed` and `consume` in `better-auth-security.ts`. A key an attacker can
  compute lets them exhaust another address's budget, and one that varies with
  something the caller controls lets them escape their own.
- **Can `@pgstencil/auth/better-auth-testing` be reached from a production
  import graph?** Start at the package's `exports` map, then at
  `examples/better-auth/src/worker.ts` and the esbuild `inject` that only test
  bundles carry. A conditional import, a re-export, or a bundler that keeps the
  module is the finding, not the presence of the file.
- **In `packages/pgstencil/src/database.ts` and `paths.ts`, is any shell or
  Compose invocation built from a path or environment value a project could
  control?** `PGSTENCIL_PROJECT_ROOT`, the derived Compose project name, the
  `pgstencil.json` migrations path, and the bundled `compose.yaml` fallback all
  cross into a child process. Look for string-built commands, unquoted
  interpolation, and a path that escapes the project root.
- **What do the integration tests not cover?** Name the gaps. A guarantee whose
  only evidence is that nobody has attacked it is worth saying out loud.
- **Have `SECURITY.md` and the code drifted?** Say which side is wrong. A bullet
  that describes a control the code no longer has is a BLOCKER; a control the
  code has that the file does not claim is an INFO.

Rate every finding BLOCKER, WARNING or INFO, and give each one a file path and
line number.

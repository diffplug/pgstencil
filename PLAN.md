# pgstencil implementation plan

Status: the first working recipe and login example are implemented. See README.md for available commands and exact behavior. The architecture below records the intended direction; extension items called out here are not all shipped.

Delivered: SQL migrations and checksum validation; reusable Docker/IntegreSQL templates and isolated leases; Kysely types/schema dump; real-port application fixtures; per-app time, randomness and email; readable file snapshots with explicit updates; the email login example; concurrency/upgrade/failure tests; and Linux CI configuration.

Remaining expansion work: automatic codegen during watch, opt-in query traces, attachment captures, a generalized snapshot identity/duplicate-path API, explicit nontransactional migrations, template seed hooks, and standalone published-package configuration/second consumer. The current package is a private workspace toolkit whose service configuration comes from this checkout. Linux CI is configured; the initial local validation ran on macOS.

Build a TypeScript/pnpm toolkit for Postgres-backed applications: version the schema, automatically prepare a reusable local database template, start isolated test applications concurrently, control server time and randomness deterministically, capture outgoing email in memory, and review their behavior through readable snapshots.

## What to carry forward

The neighboring repositories establish the intended workflow:

- `../webtools/src/main/java/com/diffplug/webtools/flywayjooq/SetupCleanupDockerFlyway.java` starts Docker, migrates `template1`, and writes a schema dump. Its configuration participates in the build lifecycle.
- `../diffplugdotcom/server/src/test/java/common/CleanPostgresModule.kt` creates a database per application from that template and drops it on application shutdown.
- `../diffplugdotcom/server/src/test/java/selfie/SelfieSettings.kt` captures multiple facets of a response: HTML, headers/cookies, Markdown, and forms. Lenses normalize local origins and select meaningful HTML before Markdown conversion.
- `../diffplugdotcom/server/src/test/java/common/EmailDev.kt` substitutes an email backend that stores messages per application, supports waiting for unread messages, and provides local message/template previews.
- `../diffplugdotcom/server/src/test/java/common/DevTime.kt` provides a mutable server-time dependency with explicit advancement. `DevNoDB.kt` injects a freshly seeded `SecureRandom` per application, and `DevRandomIsDeterministicTest.java` checks its repeatable byte sequence.

Preserve that developer experience. Use dedicated, immutable application templates instead of modifying Postgres's built-in templates. Keep application state, clocks, HTTP clients, and database pools local to each test application.

## Recommended building blocks

Dependency policy: adopt libraries that replace substantial machinery or difficult protocol semantics. Write small pgstencil-specific helpers locally using Node built-ins and the libraries already selected. Do not add dependencies merely for hashing, IDs, port selection, formatting a table, maintaining an outbox, composing lenses, or parsing a handful of CLI flags. Assess direct dependencies case by case; this is not a promise to eliminate transitive utilities used by the major libraries.

| Concern                   | Initial choice                                                                                                  | What pgstencil adds                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Runtime/tooling           | Node LTS, strict TypeScript, ESM, pnpm workspace                                                                | Pinned compatible versions, repeatable scripts                                                          |
| Postgres access           | [`pg`](https://node-postgres.com/features/queries)                                                              | Administrative connections and application pool lifecycle                                               |
| Migrations                | [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/api), SQL migration files                         | Configuration, template preparation, validation commands                                                |
| Database templates/clones | [IntegreSQL](https://github.com/allaboutapps/integresql)                                                        | Migration/seed initialization, application database lifetime and configuration                          |
| Docker                    | [Testcontainers](https://node.testcontainers.org/features/containers/) Compose support                          | Automatically start/reuse Postgres and IntegreSQL on a shared network                                   |
| Tests/snapshot storage    | [Vitest file snapshots](https://vitest.dev/guide/snapshot.html#file-snapshots)                                  | Local capture functions, lenses, stable names and readable facets                                       |
| HTML selection            | [Cheerio](https://cheerio.js.org/docs/intro/)                                                                   | Explicit content selection and exclusions                                                               |
| HTML to Markdown          | [Turndown](https://github.com/mixmark-io/turndown)                                                              | Rules for application content that generic conversion loses                                             |
| HTTP test client          | [Supertest](https://github.com/forwardemail/supertest)                                                          | Per-client fixtures, response capture, and clock integration; preserve its fluent request/assertion API |
| Cookies                   | Supertest's session agent by default                                                                            | Capture actual response cookies and exercise server-side validity using the injected time               |
| Server time               | Small local `Time` / `DevTime` implementations                                                                  | `now()`, `set(instant)`, and `advanceHours(n)` per application                                          |
| Randomness                | Small injected byte-provider interface backed by Node crypto in production and a seeded implementation in tests | Repeatable tokens, IDs, and cookie values per application                                               |
| Email                     | Small local sender interface and in-memory `EmailDev` implementation                                            | Per-application outbox, wait helper, snapshots and local previews; provider API adapter in production   |
| Application queries       | [Kysely](https://kysely.dev/) + [`kysely-codegen`](https://github.com/RobinBlomberg/kysely-codegen), using `pg` | Generate types from the migrated schema before typechecking                                             |

Use Kysely for application queries from the first example and `pg` for the driver/administrative connections. Integrate code generation once a migrated clone is available; keep raw SQL available. SQL migrations remain the schema authority. Do not build an ORM, migration executor, HTML parser, or general snapshot runner.

Use `node-pg-migrate` to apply an ordered directory of `.sql` files. Kysely is the query layer; IntegreSQL manages template preparation and allocation and calls our initializer, which runs those migrations. No Kysely migration DSL or conversion of SQL migrations into TypeScript is needed. Pin compatible stable package versions and use their documented SQL-file format.

Start with one library package, with database, application-fixture, and snapshot modules, plus one small example application in the pnpm workspace. Keep runtime database imports separate from test-only dependencies. The example can use Node's HTTP server so that selecting a website framework does not block the infrastructure.

The first example is a server-rendered email login flow supporting typed codes and clickable links, specified in [LOGIN_FLOW.md](LOGIN_FLOW.md). It includes an account page and logout, and exercises deterministic challenge/session expiry and randomness. This replaces the previously proposed notes application.

### HTTP client selection

[Supertest](https://github.com/forwardemail/supertest) is the selected RestAssured equivalent: fluent requests/assertions, form submissions, response access, and `request.agent(origin)` for automatic cookie persistence. Keep its API available; implement only application fixtures and snapshot adapters. Use `.redirects(0)` when capturing an intermediate response and explicitly opt into redirect following. Use explicit status assertions for expected non-2xx responses.

The core time-travel test checks the server's acceptance of a login cookie at controlled times. Capture the original cookie after login and explicitly replay it to prove acceptance before expiry and rejection at expiry, even if a client still sends it. This also avoids confusing missing-cookie rejection with actual expiration validation.

Supertest's cookie store uses the machine clock. An absolute `Expires` date in 2020 may be discarded by an ordinary client today; for historical-date tests, retain the actual `Set-Cookie` snapshot and explicitly send the captured cookie name/value on subsequent Supertest requests. Normal session tests can use `agent()`. Use the package's parsed cookie values or a small extraction helper for the application's known cookie format; this helper does not implement a cookie store. Preserve deterministic expiry attributes in snapshots. Browser-side cookie eviction is outside this server-time workflow; no simulated browser clock or new cookie engine is required.

## Database lifecycle

### Container ownership

`pnpm test` and `pnpm dev` automatically find or start the project's Postgres and IntegreSQL containers. Wait for a successful database query and IntegreSQL readiness. Docker must already be available. Use a shared Docker network for communication between the services, dynamic host ports for Node clients, and discovered addresses. Keep container-internal connection addresses distinct from the host-side addresses used by tests.

Reuse both services across local command invocations. Use project labels and stable container/network configuration; isolate separate checkouts by default. [Testcontainers supports reuse by configuration](https://node.testcontainers.org/features/containers/#reusing-a-container), but verify cross-process startup and stopped-container/network behavior in the first milestone. Prefer its existing coordination facilities. Add local coordination only if required. Do not build a Docker manager or a second template coordinator.

CI gets a fresh pair of services per job, shared by that job's workers, then tears them down. A test run must never stop reusable local infrastructure that another run is using. Local cache loss or service/container removal may require initialization again; ordinary warm runs must not.

Pin a concrete Postgres image version, initially in the same major version as the reference application (17), and make it configurable. Include relevant image/configuration identity in cache keys. Validate macOS Docker and Linux CI during implementation.

### Template preparation

Compute a fingerprint from ordered migration paths and bytes, deterministic template seed inputs, and schema-affecting configuration, including a pgstencil template-format version. This fingerprint identifies a template within its Postgres cluster.

Integrate with IntegreSQL's initialize/finalize and database-allocation APIs. Its [TypeScript client](https://github.com/devoxa/integresql-client) demonstrates the initializer callback and `getTestDatabase` flow. Use the client if it provides useful lifecycle/error handling; a few direct API calls can use Node fetch if that keeps the integration smaller.

Preparation protocol:

1. Ask IntegreSQL to initialize the template for this fingerprint. Only the process selected to initialize it runs the next steps; other processes wait for the ready template through IntegreSQL.
2. Connect to the assigned template database and run the ordered SQL migrations through `node-pg-migrate`.
3. Insert deterministic shared reference data, then close every initializer connection.
4. Finalize the template on success; discard a failed initialization through IntegreSQL's lifecycle API. Bound waits and test recovery from an initializer process that exits unexpectedly.
5. Allocate a separate test database from IntegreSQL for each application or database-only fixture.

Migration files used by a build must match the fingerprint even if files change during watch mode: prepare from captured inputs or detect changes and retry. Run schema dumping and type generation on allocated disposable databases, leaving the ready template available for cloning.

Each schema fingerprint is initialized once successfully per retained cache. A changed migration or seed input creates a different template; existing applications keep their allocated databases. Let IntegreSQL own pooling and cloning. Verify its reclamation behavior under long-lived applications, including intervals when application pools have no active connections; keep a fixture-lifetime connection if needed to prevent premature reclamation. Close it only when the application is finished, and use the supported recreate/release operation for dirty databases. Never return a modified database as an unchanged template clone.

### Migration discipline

Use ordered SQL migrations and the package's migration history, locking, and transaction facilities. Follow forward-only changes for shared/deployed databases. Expose migration creation, status, validation, and application through commands that use the same migration runner as template preparation.

Check whether the selected package version verifies applied migration contents. If it does not, add a small checksum manifest/validation layer for persistent databases; template fingerprinting alone is not migration-history validation. Reject changed or missing applied migrations. Support explicit nontransactional migrations through the runner's documented mechanism and test failure recovery.

Keep development databases separate from disposable test databases. Provide an explicit development reset command; schema changes must not silently delete a developer's data. Produce a stable, reviewable schema-only dump using the container's matching `pg_dump`.

## Application and test lifecycle

Define an application factory that receives its database connection, configuration, clock, and ID/randomness providers, and returns a running application handle with an asynchronous close method.

The fixture owns a database clone, an application instance, its pool, its email outbox, and independent HTTP clients. The server binds directly to `127.0.0.1:0`, then exposes its actual origin; [Node supports OS-assigned ports](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback). Avoid reserving a port and releasing it before application startup.

Default to one fresh database and application per test. Allow a test to start multiple applications, each isolated by default. A deliberately shared database for a multi-instance scenario must be explicit. Support database-only fixtures for query tests.

Register cleanup as resources are acquired, so partial startup failures also clean up. Shutdown stops requests and background work, closes pools and lifetime connections, then releases the database through IntegreSQL's supported lifecycle. Use unique run/fixture IDs for diagnostics and scope service/cache cleanup to the project. Reuse IntegreSQL's reclamation behavior; verify aborted-run recovery without deleting another active application's database. Bound pool sizes and worker concurrency against the server connection budget, including any lifetime connections.

The test client handles cookies and redirects explicitly. A cookie jar is browser-like cookie storage: it remembers cookies received in responses and sends the applicable cookies with later requests. Each client represents an independent browser session, so tests can model multiple logged-in users. Capture intermediate redirect responses and their `Set-Cookie` headers before following them. Each client has its own cookie storage: cookies are not isolated by port, so sharing storage between localhost applications would leak sessions.

## Deterministic time

Follow `DevTime`: inject a small `Time` interface with `now()` into each application. The production implementation returns real UTC time; the test implementation stores a mutable instant and exposes `set(instant)` and `advanceHours(n)` (plus simple duration/day helpers as needed). Return immutable values or defensive Date copies. Advancing time is synchronous and changes only the value returned by `now()`. No Sinon dependency, replacement of global Date/timers, or simulated timer queue.

Application timestamps, session/token creation and expiry checks, business deadlines, email timestamps, and rendered dates must use this injected time. Configure any token/session library to validate against it. Use UTC and an explicit locale by default; allow explicit time zones for calendar tests. Keep timestamps visible in snapshots so tests verify the actual values. Two concurrent applications can be set to different dates and advanced independently.

Coordinate all layers that interpret time:

- **Database:** Prefer supplying application timestamps and expiry cutoffs as SQL parameters from the clock. PostgreSQL's [`now()` and related functions](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) use database-server time; freezing JavaScript time does not control them. Any defaults, triggers, or queries that must obtain application time inside SQL should use one explicit application-time function with a scoped test override. Prove override isolation and reset across pooled connections before relying on it. Do not attempt to change the shared container's system clock.
- **Cookies:** Creation and server-side expiration validation use the application clock. Assert exact cookie timestamps and lifetime attributes, and explicitly replay captured login cookies in historical-date expiry tests as described above. The server must reject a replay at or after the expiry boundary even if the client sends it.
- **Time-dependent jobs:** If an example needs a maintenance action, expose an explicit callable operation and await it after advancing time, following DevTime's explicit job-triggering approach. Advancing the clock does not run jobs implicitly. A general scheduler is outside the initial scope.
- **Infrastructure:** Docker readiness, network timeouts, resource leases, and test-runner deadlines continue to use real elapsed time. Frozen application time must not hang setup or cleanup. Automatically generated transport timestamps, such as HTTP `Date`, need an explicit capture policy; omit them from default relevant-header snapshots while preserving application timestamps.
- **Seeds and cache:** Shared template data uses fixed explicit timestamps. Time-relative scenario data is inserted into the clone using its application's clock, so changing test time does not require rebuilding the template.

Acceptance: set time to `2020-01-01T00:00:00Z`, log in with a fixed 24-hour session lifetime, and snapshot deterministic cookie values/timestamps plus database/rendered dates. Advance 23 hours and verify the captured login cookie still authenticates; advance one more hour and verify it no longer authenticates. Use a fixed expiry with no sliding renewal for this scenario. Run beside another application at a different date and confirm isolation. Repeat on cold and warm template runs with identical snapshots and no real waiting.

## Deterministic randomness

Follow `DevNoDB`'s injected SecureRandom model with a small `RandomSource` interface, starting with `bytes(length)`. Route application-generated tokens, IDs, nonces, and other random values through it. Production uses Node's cryptographic random-byte implementation. Tests instantiate a fresh seeded byte source per application, with an optional seed override.

Implement the test source locally using a fixed, documented deterministic byte stream, for example SHA-256 blocks over a seed and counter using Node crypto. Buffer unused bytes so output is repeatable regardless of read chunk sizes. The test implementation is explicitly wired by the test/dev application factory; production construction always uses the cryptographic source. No global Math.random/crypto monkeypatch and no extra random-number package.

Use deterministic test signing/configuration keys where needed as well as deterministic inputs. SQL defaults that generate random IDs must receive explicit test values or have an explicit deterministic strategy. Infrastructure resource names use separate collision-resistant IDs, so identically seeded applications cannot collide or consume each other's random sequence. Concurrent operations whose assignment order matters should use distinct explicitly seeded sources or controlled ordering.

Acceptance: equal seeds and the same scenario yield identical tokens/cookies/email links on repeated runs; advancing time changes the intended timestamps while randomness remains reproducible; consuming bytes in one application does not change another's output. Check the byte stream with a known vector. Do not require byte-for-byte compatibility with Java's SHA1PRNG.

## Email capture and local previews

Follow EmailDev's model: inject an `EmailSender` interface into each application and use a small, entirely in-memory implementation in tests and local development. Preserve the application's normal rendering/composition path and copy the resulting message into a per-application outbox. Production implements the same interface with an email provider's HTTP API, such as Postmark; provider selection and credentials are later application configuration. No Nodemailer, SMTP server, or message-delivery dependency is needed for capture.

Expose a small API: list captured messages, consume the next unread message or batch, wait for messages with a useful real-time timeout, and assert no unread messages after expected work completes. Notify waiters when capture finishes instead of polling. Dispose pending waiters during fixture cleanup. Outboxes and read cursors must not be global.

Capture recipient fields (to/cc/bcc), sender, reply-to, subject, application headers, HTML, plaintext, and attachments when used. Reuse HTML/Markdown lenses for email snapshots. Capture time comes from the application's clock, and application-generated IDs/tokens come from its random provider; preserve meaningful link values. Provider-generated delivery IDs and MIME encoding are outside the in-memory capture contract.

Provide a local development inbox with message HTML/plaintext views and registered template previews using fixed example data, matching EmailDev's useful workflow. Mount these routes only in development/test configurations. An external SMTP catcher is unnecessary for the initial injected sender.

Acceptance: request a login email containing both a code and a link; await its capture and snapshot recipients/subject/HTML/plaintext/Markdown. Exercise code entry and link confirmation in separate fixtures, then advance time in fresh fixtures to verify expiry. Verify two parallel applications cannot see each other's mail; checking for unexpected extra messages and wait timeout errors must work. No test/development message is delivered externally.

## Local snapshots and lenses

Build a small local API that captures values into named text facets, applies pure transformations, and passes the resulting text to Vitest. No dependency on completing Selfie's JavaScript implementation. Keep capture and lens functions independent of Vitest so a future Selfie adapter is possible.

| Capture             | Facets and behavior                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Query result        | Readable rows with column names, explicit nulls, and stable representations for timestamps, decimals, bigint, JSON and binary values      |
| Query trace, opt-in | SQL and parameters captured separately, with ordering semantics declared; query timings excluded                                          |
| HTTP response       | Status, relevant headers, redirect location, and every `Set-Cookie` header                                                                |
| Cookies             | Names, normalized values where requested, domain/path, expiry, HttpOnly, Secure and SameSite; optionally jar state after the response     |
| Email               | Recipients/headers, subject, plaintext, HTML, derived Markdown, and relevant attachment metadata                                          |
| HTML                | Original response body by default; readable formatting as an explicit lens with whitespace-sensitive cases covered                        |
| Markdown            | Selected HTML converted to readable content, preserving links, tables, images and meaningful form/iframe information through custom rules |

Preserve query row order. Tests should use `ORDER BY` or explicitly request an unordered comparison. Normalize only declared unstable fields. Prefer an injected clock and deterministic IDs over broad replacement patterns. Map only the fixture's known origin to a stable test origin, preserving meaningful URL differences. Cookie normalization must preserve security attributes and expiry behavior.

Support selector-based inclusion/exclusion and a composed Markdown lens. Use the existing project's `.selfie` and `.selfie-exclude` conventions as reference behavior; decide the new default selectors in the example. Keep full HTML alongside the reduced Markdown view so conversion does not conceal structural changes. Add a forms facet only if Markdown rules are insufficient for readable assertions.

Store snapshots beside tests, under a dedicated directory such as `snapshots/<test-name>/<checkpoint>.md`, with related HTML or JSON files where useful. A Markdown report may group small facets under headings. Start with Vitest's file matcher and update/diff behavior; evaluate file count/readability using the example before inventing a grouped storage format.

Snapshot identity must derive from the test path, full test name, explicit case ID where needed, and checkpoint name, never from ports, workers, or invocation order. Use [the test-local `expect` in concurrent Vitest tests](https://vitest.dev/api/test.html). Reject duplicate output paths. Normal test runs only compare; an explicit update command writes accepted baselines. CI rejects missing or changed snapshots. Prevent simultaneous update processes from writing the same files.

## Implementation sequence and acceptance checks

1. **Foundation and IntegreSQL integration.** Scaffold the workspace and one SQL migration. Start Postgres and IntegreSQL automatically through Testcontainers, run `node-pg-migrate` inside template initialization, and allocate two independently writable databases. Acceptance: a second invocation reuses both services/template without rerunning migrations; simultaneous cold invocations converge on one ready template; a migration change produces a new template. Verify host/container address mapping and database lifetime during idle connection-pool periods.

2. **Database lifecycle and migration workflow.** Add fixture teardown, interrupted-build recovery, persistent-database validation, schema dump, development database commands, and ownership-aware cleanup. Integrate Kysely/codegen using a disposable clone, with driver-aligned date/numeric mappings; commit generated declarations and generate before typechecking. Acceptance: failed migration preparation cannot poison the cache; applied migration edits are rejected for persistent databases; upgrading a database with representative existing data preserves that data and reaches the expected schema; a renamed/dropped column produces a compile error in a typed query after regeneration. Fresh-schema testing alone is insufficient.

3. **Parallel fixtures, deterministic time/randomness, and email.** Add the application factory, real HTTP listener, Supertest clients, local DevTime and seeded random providers, in-memory email outboxes, and Vitest fixtures. Acceptance: pass the Jan 1 / 23-hour / 24-hour login test and deterministic-randomness checks above; run at least 20 lightweight applications simultaneously with unique ports/databases and isolated writes, cookies, time, random state, and captured email; run two independent test processes simultaneously; verify normal and partial-failure cleanup. Record resource limits and provisioning timings.

4. **Email login example and snapshot vertical slice.** Implement [LOGIN_FLOW.md](LOGIN_FLOW.md): emailed code/link, confirmation, account page, logout, short-lived challenges, and fixed 24-hour sessions. Snapshot query results, cookies, HTML, derived Markdown, and captured email at controlled times. Add local inbox/template previews. Acceptance: pass the flow's functional/security scenarios; intentional changes to each facet fail the corresponding assertion; cold and warm repeats are identical; explicit updates create clear diffs; meaningful timestamps/form/link/cookie attributes survive lenses. Review the actual artifacts before expanding the snapshot API.

5. **CI and developer workflow.** Wire frozen-lockfile installation, formatting/linting, typechecking, unit tests, migration upgrade checks, and Docker integration tests. Add focused/watch test commands, diagnostics, cache status, and stale-resource cleanup. Acceptance: clean Linux CI and local macOS runs pass without manual database preparation; watch mode notices migration changes; aborted runs are recoverable; snapshot mismatches fail without rewriting files. Report cold setup, warm setup, clone, and suite timings before setting performance thresholds.

6. **Query workflow polish.** Verify generated declaration freshness in CI, watch-mode regeneration, and ordinary editor/typechecking operation without Docker using committed declarations. Demonstrate joins and raw SQL escape hatches through Kysely in the example, and document the limits of generated types. Core query/type generation is already part of milestone 2.

7. **Package and document the reusable recipe.** Exercise pgstencil from a second minimal consumer, finalize exports/configuration, and document the migration and snapshot review workflow, resource lifecycle, and extension points. Only split packages if the consumer exposes a concrete need. Publishing and the choice to replace the local snapshot layer with Selfie remain later decisions.

## Intended commands

These commands are available; README.md documents their exact current behavior.

| Command                               | Intended result                                                           |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm test`                           | Prepare infrastructure automatically and run the suite                    |
| `pnpm test:watch`                     | Reuse infrastructure and rerun affected tests                             |
| `pnpm snapshot:update`                | Explicitly update reviewed snapshot baselines                             |
| `pnpm db:migration:create <name>`     | Create the next SQL migration                                             |
| `pnpm db:status` / `pnpm db:validate` | Inspect migration history and validate applied contents                   |
| `pnpm db:migrate`                     | Apply pending migrations to the explicitly configured persistent database |
| `pnpm db:schema`                      | Regenerate the reviewable schema dump                                     |
| `pnpm db:types`                       | Regenerate Kysely query types                                             |
| `pnpm dev`                            | Start the example using its persistent development database               |
| `pnpm db:reset`                       | Explicitly recreate the development database                              |
| `pnpm db:gc` / `pnpm db:stop`         | Reclaim stale owned resources / stop an idle local container              |
| `pnpm check`                          | Run the repository's required verification                                |

The first useful deliverable is one test that starts from Docker availability, prepares the schema through SQL migrations and IntegreSQL, serves a real request on an assigned port with controlled time/randomness, and produces all four original snapshot views plus captured email. The must-have milestone is complete when that workflow remains deterministic under parallel tests with independent time, random sources and outboxes, explicit time advancement, separate test processes, repeated warm runs, migration changes, and failure recovery.

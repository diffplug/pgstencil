# pgstencil

Postgres schema migrations, isolated test databases, and deterministic snapshot testing for TypeScript.

> **Built for our own applications.** pgstencil is developed alongside DiffPlug's products and published so they can share it. It is 0.x: a minor release may break compatibility, and there is no support promise.

```sh
pnpm add pgstencil kysely
# Only for pgstencil/database, pgstencil/testing and pgstencil/snapshots:
pnpm add -D testcontainers node-pg-migrate cheerio turndown
```

`kysely` is a peer dependency: your application owns its version and shares one copy with pgstencil. The test, migration and snapshot tooling loads optional peers, so a production install of the runtime entry points never carries the Docker client or the HTML converter; [PACKAGES.md](https://github.com/diffplug/pgstencil/blob/main/PACKAGES.md#tooling-peers) lists which entry point needs which. See [PACKAGES.md](https://github.com/diffplug/pgstencil/blob/main/PACKAGES.md) for usage and the dependency policy, and [SECURITY.md](https://github.com/diffplug/pgstencil/blob/main/SECURITY.md) for the audited security rules. Source: [diffplug/pgstencil](https://github.com/diffplug/pgstencil).

# pgstencil

Postgres schema migrations, isolated test databases, and deterministic snapshot testing for TypeScript.

> **Built for our own applications.** pgstencil is developed alongside DiffPlug's products and published so they can share it. It is 0.x: a minor release may break compatibility, and there is no support promise.

```sh
pnpm add pgstencil kysely
```

`kysely` is a peer dependency: your application owns its version and shares one copy with pgstencil. See [PACKAGES.md](https://github.com/diffplug/pgstencil/blob/main/PACKAGES.md) for usage and the dependency policy, and [SECURITY.md](https://github.com/diffplug/pgstencil/blob/main/SECURITY.md) for the audited security rules. Source: [diffplug/pgstencil](https://github.com/diffplug/pgstencil).

# @pgstencil/stripe

Stripe SaaS subscriptions with named plans, optional card-required trials, durable webhooks, and a local payment simulator for pgstencil.

> **Built for our own applications.** pgstencil is developed alongside DiffPlug's products and published so they can share it. It is 0.x: a minor release may break compatibility, and there is no support promise.

```sh
pnpm add @pgstencil/stripe pgstencil kysely stripe@~23.1.0
```

The packages after the first are peer dependencies: your application owns their versions and shares one copy with pgstencil. See [PACKAGES.md](https://github.com/diffplug/pgstencil/blob/main/PACKAGES.md) for usage and the dependency policy, and [SECURITY.md](https://github.com/diffplug/pgstencil/blob/main/SECURITY.md) for the audited security rules. Source: [diffplug/pgstencil](https://github.com/diffplug/pgstencil).

It peers on `stripe` 23. `STRIPE_API_VERSION`, which webhooks must match, is the installed SDK's pinned API version (`2026-10-28.endive` for 23.1) and moves with every SDK minor release, so pin `stripe` with `~` and follow [Moving to a new Stripe API version](https://github.com/diffplug/pgstencil/blob/main/BILLING.md#moving-to-a-new-stripe-api-version) to change it.

---
title: Migrating to 2.0
description: What changes from Vector 1.x to 2.0 and how to upgrade, step by step.
---

Vector 2.0 adds ordered delivery, payload filters, replay, pruning and a versioned database schema. The sending API of 1.x keeps working. This page lists everything that can break and how to fix it. Vector 1.x receives security and bug fixes for 12 months after the release of 2.0.0.

## Breaking changes

1. **Node.js 22 or newer.** Node 20 reached end of life; 2.0 declares `engines.node >=22`.
2. **Database schema version 2.** Three nullable columns are new (`filter` on endpoints, `ordering_key` on messages and deliveries), plus an index and a `<prefix>schema` table that records the version. Run `await store.migrate()` once after updating; it adds what is missing and is safe on every deploy. The SQL returned by `sqliteSchema()`, `mysqlSchema()` and `postgresSchema()` is for **fresh installs**; if you manage migrations with your own tool, use the new SQL as the target and write an `alter table ... add column` for each column above, or simply call `store.migrate()` at startup.
3. **New fields on stored objects.** `Endpoint.filter` (`PayloadFilter | null`), `Message.orderingKey` and `Delivery.orderingKey` (`string | null`) are always present. Code that builds these objects by hand (tests, fixtures) must add them with `null`.
4. **Custom stores.** `VectorStore` has two new methods: `deleteMessagesBefore(before, limit)` and `schemaVersion()`, and `claimDueDeliveries` must skip a pending delivery while an earlier pending delivery of the same endpoint and `orderingKey` exists. If you only use `MemoryStore`, `SqliteStore`, `MysqlStore` or `PostgresStore`, nothing to do. `MessageQuery` also has an optional `beforeId` for stable paging.
5. **Vector Pro** packages 2.x need `@sweberdev/vector` 2.x. Install both from the same major version. Existing Pro and Lifetime licences stay valid.

## What 1.x code does not need to change

`send`, `sendMany`, endpoints, signing, retries, `process`/`start`, the CLI and the adapters behave as in 1.x. No exports were renamed; nothing marked `@deprecated` remained in 1.x.

## Upgrade steps

1. Update the package: `npm install @sweberdev/vector@2` (or `@next` while 2.0 is a release candidate).
2. Update Node.js to 22 in CI and in production.
3. Deploy once so that `await store.migrate()` runs, or run it from a script. Old workers can keep running during a rolling deploy: the new columns are nullable and 1.x ignores them.
4. Optionally check `await store.schemaVersion()`; it returns `2` afterwards.
5. If you have a custom `VectorStore`, add the two methods and the ordering rule, and run your tests.
6. Update Pro packages together to the same 2.x version.

## New in 2.0

- `orderingKey` on `send`: per-key ordered delivery. See [Sending](guides/sending.md#ordered-delivery).
- `filter` on endpoints: payload conditions. See [Sending](guides/sending.md#payload-filters).
- `vector.replay()` and `vector.prune()`. See [Replaying history](guides/sending.md#replaying-history) and [Operations](guides/operations.md).
- `store.schemaVersion()` and the `SCHEMA_VERSION` export.

## Rolling back

Going back to 1.x is safe: the extra columns are ignored by 1.x. Ordered messages sent under 2.0 are delivered without ordering by 1.x.

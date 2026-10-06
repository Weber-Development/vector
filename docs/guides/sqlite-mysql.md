---
title: SQLite and MySQL
description: Keep endpoints, messages and the delivery log in SQLite or MySQL.
---

Besides [PostgreSQL](postgres.md), Vector ships stores for SQLite and MySQL. All three keep the same four tables and behave the same; pick the database your app already has.

## SQLite

For a single server, a small app, a desktop or edge app, or local development. The store takes a synchronous database: `DatabaseSync` from `node:sqlite` (Node.js 22.5+) or `better-sqlite3`.

```ts
import { DatabaseSync } from "node:sqlite";
import { createVector } from "@sweberdev/vector";
import { createSqliteStore } from "@sweberdev/vector/sqlite";

const store = createSqliteStore({ database: new DatabaseSync("webhooks.db") });
await store.migrate();

export const vector = createVector({ store });
```

With `better-sqlite3` it is `new Database("webhooks.db")` in place of `DatabaseSync`. Several worker processes can share one database file: claiming due deliveries is a single statement, so no delivery is sent twice. Turn on WAL mode (`database.exec("pragma journal_mode = wal")`) when several processes write.

## MySQL

For MySQL 8. Vector has no dependency on a driver. You pass a `query(sql, params)` function that returns `{ rows, affectedRows }`; for `mysql2` there is an adapter:

```ts
import mysql from "mysql2/promise";
import { createVector } from "@sweberdev/vector";
import { createMysqlStore, mysql2Query } from "@sweberdev/vector/mysql";

const pool = mysql.createPool(process.env.DATABASE_URL!);
const store = createMysqlStore({ query: mysql2Query(pool) });
await store.migrate();

export const vector = createVector({ store });
```

The store is safe with several workers: due deliveries are claimed with one `update … order by … limit`, which InnoDB locks row by row.

## Migrations

`store.migrate()` runs `create table if not exists` statements and is safe to call on every start. To add the tables with your own migration tool, take the SQL from `sqliteSchema()` or `mysqlSchema()`. The tables are `vector_endpoints`, `vector_messages`, `vector_deliveries` and `vector_attempts`; change the prefix with `tablePrefix`.

Times are stored as milliseconds since the epoch, so no time zone setting of the server or the driver changes them. JSON is stored as text.

## Growth

These stores have no foreign keys, so delete old rows from all four tables, for example everything older than 30 days:

```sql
delete from vector_attempts where at < :cutoff;
delete from vector_deliveries where created_at < :cutoff;
delete from vector_messages where created_at < :cutoff;
```

`:cutoff` is a time in milliseconds, for example `Date.now() - 30 * 86_400_000`.

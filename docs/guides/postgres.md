---
title: PostgreSQL
description: Keep endpoints, messages and the delivery log in PostgreSQL, with any driver.
---

The PostgreSQL store keeps everything in four tables and is safe to use from several workers: due deliveries are claimed with `for update skip locked`, so no delivery is sent twice at the same time.

```ts
import pg from "pg";
import { createVector } from "@sweberdev/vector";
import { createPostgresStore } from "@sweberdev/vector/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresStore({ query: (text, params) => pool.query(text, params) });
await store.migrate(); // creates the tables if they do not exist

export const vector = createVector({ store });
```

Vector has no dependency on a driver. You pass a `query(text, params)` function that returns `{ rows }`:

| Driver | `query` |
|---|---|
| `pg` | `(text, params) => pool.query(text, params)` |
| postgres.js | `(text, params) => sql.unsafe(text, params).then((rows) => ({ rows }))` |
| Neon serverless | `(text, params) => pool.query(text, params)` with `Pool` from `@neondatabase/serverless` |
| PGlite | `(text, params) => db.query(text, params)` |

Supabase and other hosted PostgreSQL work with any of these drivers.

## Migrations

`store.migrate()` runs `create table if not exists` statements and is safe to call on every start. If you manage migrations yourself (Drizzle, Prisma, Flyway), take the SQL from `postgresSchema()` and add it as a migration instead:

```ts
import { postgresSchema } from "@sweberdev/vector/postgres";
console.log(postgresSchema("vector_"));
```

The tables are `vector_endpoints`, `vector_messages`, `vector_deliveries` and `vector_attempts`. Change the prefix with `tablePrefix`.

## Growth

Every attempt is a row. Delete old rows regularly, for example messages older than 30 days (deliveries and attempts are removed with them by `on delete cascade`):

```sql
delete from vector_messages where created_at < now() - interval '30 days';
```

Vector Pro has a retention helper that does this in batches.

## Your own database

Any database works if you implement the `VectorStore` interface (about fifteen small methods). The one that needs care is `claimDueDeliveries`: it must atomically lock the deliveries it returns, so that two workers never get the same one.

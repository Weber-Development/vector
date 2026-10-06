import { type DedupeDriver, type SqlDeduper, type SqlDeduperOptions, sqlDeduper } from "./dedupe";
import { checkPrefix, type SqlDialect, type SqlExecutor, SqlStore } from "./sql";

/**
 * A synchronous SQLite database. Fits `DatabaseSync` from `node:sqlite` (Node 22.5+) and
 * `better-sqlite3` directly.
 */
export interface SqliteDatabase {
  prepare(sql: string): {
    all(...params: never[]): unknown[];
    run(...params: never[]): { changes: number | bigint };
  };
}

export interface SqliteStoreOptions {
  database: SqliteDatabase;
  /** Prefix for the four tables. Default `vector_`. */
  tablePrefix?: string;
}

/** The SQL that creates the tables. Run it once, e.g. in a migration, or call `store.migrate()`. */
export function sqliteSchema(tablePrefix = "vector_"): string {
  return `${statements(checkPrefix(tablePrefix)).join(";\n")};\n`;
}

function statements(p: string): string[] {
  return [
    `create table if not exists ${p}endpoints (
  id text primary key,
  tenant text,
  url text not null,
  description text,
  secret text not null,
  previous_secret text,
  previous_secret_expires_at integer,
  event_types text,
  headers text not null default '{}',
  metadata text not null default '{}',
  enabled integer not null default 1,
  disabled_reason text,
  failure_streak integer not null default 0,
  created_at integer not null,
  updated_at integer not null
)`,
    `create index if not exists ${p}endpoints_tenant_idx on ${p}endpoints (tenant, created_at desc)`,
    `create table if not exists ${p}messages (
  id text primary key,
  tenant text,
  event_type text not null,
  payload text not null,
  idempotency_key text,
  created_at integer not null
)`,
    `create unique index if not exists ${p}messages_idempotency_idx
  on ${p}messages (coalesce(tenant, ''), idempotency_key) where idempotency_key is not null`,
    `create index if not exists ${p}messages_tenant_idx on ${p}messages (tenant, created_at desc)`,
    `create table if not exists ${p}deliveries (
  id text primary key,
  message_id text not null,
  endpoint_id text not null,
  tenant text,
  event_type text not null,
  status text not null,
  attempts integer not null default 0,
  next_attempt_at integer,
  locked_until integer,
  lock_token text,
  last_attempt_at integer,
  last_status_code integer,
  last_error text,
  created_at integer not null,
  updated_at integer not null
)`,
    `create index if not exists ${p}deliveries_due_idx on ${p}deliveries (next_attempt_at) where status = 'pending'`,
    `create index if not exists ${p}deliveries_lock_idx on ${p}deliveries (lock_token)`,
    `create index if not exists ${p}deliveries_message_idx on ${p}deliveries (message_id)`,
    `create index if not exists ${p}deliveries_endpoint_idx on ${p}deliveries (endpoint_id, created_at desc)`,
    `create index if not exists ${p}deliveries_tenant_idx on ${p}deliveries (tenant, created_at desc)`,
    `create table if not exists ${p}attempts (
  id text primary key,
  delivery_id text not null,
  message_id text not null,
  endpoint_id text not null,
  tenant text,
  at integer not null,
  duration_ms integer not null,
  status_code integer,
  success integer not null,
  error text,
  response_body text
)`,
    `create index if not exists ${p}attempts_delivery_idx on ${p}attempts (delivery_id)`,
    `create index if not exists ${p}attempts_endpoint_idx on ${p}attempts (endpoint_id, at desc)`,
    `create index if not exists ${p}attempts_message_idx on ${p}attempts (message_id)`,
    `create index if not exists ${p}attempts_tenant_idx on ${p}attempts (tenant, at desc)`,
  ];
}

const dialect: SqlDialect = {
  schema: statements,
  // SQLite only allows ORDER BY and LIMIT on UPDATE with a compile option, hence the subquery.
  // The statement runs as one write transaction, so two processes never claim the same row.
  claim: (table, limit) => `update ${table} set locked_until = ?, lock_token = ?
    where id in (
      select id from ${table}
      where status = 'pending' and next_attempt_at <= ?
        and (locked_until is null or locked_until <= ?)
      order by next_attempt_at
      limit ${limit}
    )`,
};

function executor(database: SqliteDatabase): SqlExecutor {
  const cache = new Map<string, ReturnType<SqliteDatabase["prepare"]>>();
  const prepare = (sql: string) => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = database.prepare(sql);
      if (cache.size > 200) cache.clear();
      cache.set(sql, statement);
    }
    return statement;
  };
  return {
    all: async (sql, params) =>
      prepare(sql).all(...(params as never[])) as Record<string, unknown>[],
    run: async (sql, params) => Number(prepare(sql).run(...(params as never[])).changes),
  };
}

/**
 * A `VectorStore` on SQLite, for a single server, a small app or local development. Several
 * worker processes on the same database file are safe: claiming due deliveries is one statement.
 */
export class SqliteStore extends SqlStore {
  constructor(options: SqliteStoreOptions) {
    super(executor(options.database), dialect, options.tablePrefix ?? "vector_");
  }
}

/** Creates a SQLite store. Call `await store.migrate()` once, or run `sqliteSchema()` yourself. */
export function createSqliteStore(options: SqliteStoreOptions): SqliteStore {
  return new SqliteStore(options);
}

/**
 * Remembers handled webhook ids in a SQLite table. Call `await deduper.migrate()` once, and
 * `deduper.prune()` now and then to drop old ids.
 */
export function sqliteDeduper(
  options: { database: SqliteDatabase } & SqlDeduperOptions,
): SqlDeduper {
  const { database } = options;
  const run = (sql: string, params: unknown[]) =>
    Number(database.prepare(sql).run(...(params as never[])).changes);
  const driver: DedupeDriver = {
    run: async (sql) => void run(sql, []),
    deleteExpired: async (table, id, nowMs) =>
      void run(`delete from ${table} where id = ? and expires_at <= ?`, [id, nowMs]),
    insert: async (table, id, expiresMs) =>
      run(`insert or ignore into ${table} (id, expires_at) values (?, ?)`, [id, expiresMs]) === 1,
    remove: async (table, id) => void run(`delete from ${table} where id = ?`, [id]),
    deleteAllExpired: async (table, nowMs) =>
      run(`delete from ${table} where expires_at <= ?`, [nowMs]),
  };
  return sqlDeduper(
    driver,
    (table) => [
      `create table if not exists ${table} (id text primary key, expires_at integer not null)`,
      `create index if not exists ${table}_expires on ${table} (expires_at)`,
    ],
    options,
  );
}

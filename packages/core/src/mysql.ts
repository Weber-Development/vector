import { type DedupeDriver, type SqlDeduper, type SqlDeduperOptions, sqlDeduper } from "./dedupe";
import { checkPrefix, type SqlDialect, SqlStore } from "./sql";
import { SCHEMA_VERSION } from "./types";

/**
 * Runs one parameterised statement with `?` placeholders. Returns the rows of a select and the
 * number of affected rows of everything else. For `mysql2`, use `mysql2Query(pool)`.
 */
export type MysqlQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; affectedRows: number }>;

export interface MysqlStoreOptions {
  query: MysqlQuery;
  /** Prefix for the four tables. Default `vector_`. */
  tablePrefix?: string;
}

/** The part of a `mysql2/promise` pool or connection the store needs. */
export interface Mysql2Queryable {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

/** Adapts a `mysql2/promise` pool or connection: `mysql2Query(mysql.createPool(url))`. */
export function mysql2Query(pool: Mysql2Queryable): MysqlQuery {
  return async (sql, params) => {
    const [result] = await pool.query(sql, params);
    if (Array.isArray(result))
      return { rows: result as Record<string, unknown>[], affectedRows: 0 };
    return {
      rows: [],
      affectedRows: Number((result as { affectedRows?: number }).affectedRows ?? 0),
    };
  };
}

/** The SQL that creates the tables. Run it once, e.g. in a migration, or call `store.migrate()`. */
export function mysqlSchema(tablePrefix = "vector_"): string {
  const p = checkPrefix(tablePrefix);
  const version = `delete from ${p}schema;\ninsert into ${p}schema (version) values (${SCHEMA_VERSION})`;
  return `${[...statements(p), orderIndex(p).sql, version].join(";\n")};\n`;
}

// Dates are milliseconds since the epoch (bigint), so no time zone setting of the server or the
// driver changes them. Indexes are part of CREATE TABLE because MySQL has no
// CREATE INDEX IF NOT EXISTS.
function statements(p: string): string[] {
  return [
    `create table if not exists ${p}endpoints (
  id varchar(64) not null primary key,
  tenant varchar(255) null,
  url text not null,
  description text null,
  secret varchar(255) not null,
  previous_secret varchar(255) null,
  previous_secret_expires_at bigint null,
  event_types text null,
  filter text null,
  headers text not null,
  metadata text not null,
  enabled tinyint(1) not null default 1,
  disabled_reason text null,
  failure_streak int not null default 0,
  created_at bigint not null,
  updated_at bigint not null,
  index ${p}endpoints_tenant_idx (tenant, created_at)
) character set utf8mb4 collate utf8mb4_bin`,
    `create table if not exists ${p}messages (
  id varchar(64) not null primary key,
  tenant varchar(255) null,
  tenant_key varchar(255) generated always as (coalesce(tenant, '')) stored,
  event_type varchar(255) not null,
  payload longtext not null,
  idempotency_key varchar(255) null,
  ordering_key varchar(255) null,
  created_at bigint not null,
  unique index ${p}messages_idempotency_idx (tenant_key, idempotency_key),
  index ${p}messages_tenant_idx (tenant, created_at)
) character set utf8mb4 collate utf8mb4_bin`,
    `create table if not exists ${p}deliveries (
  id varchar(64) not null primary key,
  message_id varchar(64) not null,
  endpoint_id varchar(64) not null,
  tenant varchar(255) null,
  event_type varchar(255) not null,
  ordering_key varchar(255) null,
  status varchar(16) not null,
  attempts int not null default 0,
  next_attempt_at bigint null,
  locked_until bigint null,
  lock_token varchar(64) null,
  last_attempt_at bigint null,
  last_status_code int null,
  last_error text null,
  created_at bigint not null,
  updated_at bigint not null,
  index ${p}deliveries_due_idx (status, next_attempt_at),
  index ${p}deliveries_lock_idx (lock_token),
  index ${p}deliveries_message_idx (message_id),
  index ${p}deliveries_endpoint_idx (endpoint_id, created_at),
  index ${p}deliveries_tenant_idx (tenant, created_at)
) character set utf8mb4 collate utf8mb4_bin`,
    `create table if not exists ${p}attempts (
  id varchar(64) not null primary key,
  delivery_id varchar(64) not null,
  message_id varchar(64) not null,
  endpoint_id varchar(64) not null,
  tenant varchar(255) null,
  at bigint not null,
  duration_ms int not null,
  status_code int null,
  success tinyint(1) not null,
  error text null,
  response_body mediumtext null,
  index ${p}attempts_delivery_idx (delivery_id),
  index ${p}attempts_endpoint_idx (endpoint_id, at),
  index ${p}attempts_message_idx (message_id),
  index ${p}attempts_tenant_idx (tenant, at)
) character set utf8mb4 collate utf8mb4_bin`,
    `create table if not exists ${p}schema (version int not null) character set utf8mb4 collate utf8mb4_bin`,
  ];
}

/** Columns that came after 1.x: table, column. */
const ADDED_COLUMNS = [
  ["endpoints", "filter", "text null"],
  ["messages", "ordering_key", "varchar(255) null"],
  ["deliveries", "ordering_key", "varchar(255) null"],
] as const;

/** Index on a column that older versions did not have; MySQL has no CREATE INDEX IF NOT EXISTS. */
function orderIndex(p: string) {
  return {
    name: `${p}deliveries_order_idx`,
    sql: `create index ${p}deliveries_order_idx on ${p}deliveries (endpoint_id, ordering_key, created_at)`,
  };
}

const dialect: SqlDialect = {
  schema: statements,
  async upgrade(p, db) {
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const found = await db.all(
        `select column_name as name from information_schema.columns
         where table_schema = database() and table_name = ? and column_name = ?`,
        [`${p}${table}`, column],
      );
      if (found.length === 0) {
        await db.run(`alter table ${p}${table} add column ${column} ${definition}`, []);
      }
    }
    const index = orderIndex(p);
    const found = await db.all(
      `select index_name as name from information_schema.statistics
       where table_schema = database() and table_name = ? and index_name = ? limit 1`,
      [`${p}deliveries`, index.name],
    );
    if (found.length === 0) await db.run(index.sql, []);
  },
  // One UPDATE: InnoDB locks the rows it changes, so a second worker running the same statement
  // waits, and then skips them because the outer conditions are checked again on the locked row.
  // The derived table is needed because MySQL cannot select from the table it updates otherwise.
  claim: (table, limit, lockedUntil, lockToken, now) => ({
    sql: `update ${table} set locked_until = ?, lock_token = ?
    where id in (
      select id from (
        select d.id from ${table} d
        where d.status = 'pending' and d.next_attempt_at <= ?
          and (d.locked_until is null or d.locked_until <= ?)
          and (d.ordering_key is null or not exists (
            select 1 from ${table} e
            where e.endpoint_id = d.endpoint_id and e.ordering_key = d.ordering_key
              and e.status = 'pending'
              and (e.created_at < d.created_at or (e.created_at = d.created_at and e.id < d.id))))
        order by d.next_attempt_at
        limit ${limit}
      ) picked
    )
    and status = 'pending' and next_attempt_at <= ?
    and (locked_until is null or locked_until <= ?)`,
    params: [lockedUntil, lockToken, now, now, now, now],
  }),
};

/** A `VectorStore` on MySQL 8. Safe with several workers. */
export class MysqlStore extends SqlStore {
  constructor(options: MysqlStoreOptions) {
    const { query } = options;
    super(
      {
        all: async (sql, params) => (await query(sql, params)).rows,
        run: async (sql, params) => (await query(sql, params)).affectedRows,
      },
      dialect,
      options.tablePrefix ?? "vector_",
    );
  }
}

/** Creates a MySQL store. Call `await store.migrate()` once, or run `mysqlSchema()` yourself. */
export function createMysqlStore(options: MysqlStoreOptions): MysqlStore {
  return new MysqlStore(options);
}

/**
 * Remembers handled webhook ids in a MySQL table. Call `await deduper.migrate()` once, and
 * `deduper.prune()` now and then to drop old ids.
 */
export function mysqlDeduper(options: { query: MysqlQuery } & SqlDeduperOptions): SqlDeduper {
  const { query } = options;
  const driver: DedupeDriver = {
    run: async (sql) => void (await query(sql, [])),
    deleteExpired: async (table, id, nowMs) =>
      void (await query(`delete from ${table} where id = ? and expires_at <= ?`, [id, nowMs])),
    insert: async (table, id, expiresMs) =>
      (await query(`insert ignore into ${table} (id, expires_at) values (?, ?)`, [id, expiresMs]))
        .affectedRows === 1,
    remove: async (table, id) => void (await query(`delete from ${table} where id = ?`, [id])),
    deleteAllExpired: async (table, nowMs) =>
      (await query(`delete from ${table} where expires_at <= ?`, [nowMs])).affectedRows,
  };
  return sqlDeduper(
    driver,
    (table) => [
      `create table if not exists ${table} (id varchar(255) primary key, expires_at bigint not null, key ${table}_expires (expires_at))`,
    ],
    options,
  );
}

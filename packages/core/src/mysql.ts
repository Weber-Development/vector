import { checkPrefix, type SqlDialect, SqlStore } from "./sql";

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
  return `${statements(checkPrefix(tablePrefix)).join(";\n")};\n`;
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
  ];
}

const dialect: SqlDialect = {
  schema: statements,
  // One UPDATE with ORDER BY and LIMIT: InnoDB locks the rows it changes, so a second worker
  // running the same statement waits and then skips them because they are locked until later.
  claim: (table, limit) => `update ${table} set locked_until = ?, lock_token = ?
    where status = 'pending' and next_attempt_at <= ?
      and (locked_until is null or locked_until <= ?)
    order by next_attempt_at
    limit ${limit}`,
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

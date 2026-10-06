import { type DedupeDriver, type SqlDeduper, type SqlDeduperOptions, sqlDeduper } from "./dedupe";
import type {
  Attempt,
  AttemptQuery,
  Delivery,
  DeliveryQuery,
  Endpoint,
  EndpointQuery,
  Message,
  MessageQuery,
  VectorStore,
} from "./types";

/**
 * Runs one parameterised statement. Fits `pg` (`pool.query`) directly; for other drivers wrap
 * them, e.g. postgres.js: `(text, params) => sql.unsafe(text, params).then((rows) => ({ rows }))`.
 */
export type PostgresQuery = (
  text: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface PostgresStoreOptions {
  query: PostgresQuery;
  /** Prefix for the four tables. Default `vector_`. */
  tablePrefix?: string;
}

type Column = { name: string; json?: boolean };

const ENDPOINT_COLUMNS: Record<keyof Endpoint, Column> = {
  id: { name: "id" },
  tenant: { name: "tenant" },
  url: { name: "url" },
  description: { name: "description" },
  secret: { name: "secret" },
  previousSecret: { name: "previous_secret" },
  previousSecretExpiresAt: { name: "previous_secret_expires_at" },
  eventTypes: { name: "event_types", json: true },
  headers: { name: "headers", json: true },
  metadata: { name: "metadata", json: true },
  enabled: { name: "enabled" },
  disabledReason: { name: "disabled_reason" },
  failureStreak: { name: "failure_streak" },
  createdAt: { name: "created_at" },
  updatedAt: { name: "updated_at" },
};

const MESSAGE_COLUMNS: Record<keyof Message, Column> = {
  id: { name: "id" },
  tenant: { name: "tenant" },
  eventType: { name: "event_type" },
  payload: { name: "payload", json: true },
  idempotencyKey: { name: "idempotency_key" },
  createdAt: { name: "created_at" },
};

const DELIVERY_COLUMNS: Record<keyof Delivery, Column> = {
  id: { name: "id" },
  messageId: { name: "message_id" },
  endpointId: { name: "endpoint_id" },
  tenant: { name: "tenant" },
  eventType: { name: "event_type" },
  status: { name: "status" },
  attempts: { name: "attempts" },
  nextAttemptAt: { name: "next_attempt_at" },
  lockedUntil: { name: "locked_until" },
  lastAttemptAt: { name: "last_attempt_at" },
  lastStatusCode: { name: "last_status_code" },
  lastError: { name: "last_error" },
  createdAt: { name: "created_at" },
  updatedAt: { name: "updated_at" },
};

const ATTEMPT_COLUMNS: Record<keyof Attempt, Column> = {
  id: { name: "id" },
  deliveryId: { name: "delivery_id" },
  messageId: { name: "message_id" },
  endpointId: { name: "endpoint_id" },
  tenant: { name: "tenant" },
  at: { name: "at" },
  durationMs: { name: "duration_ms" },
  statusCode: { name: "status_code" },
  success: { name: "success" },
  error: { name: "error" },
  responseBody: { name: "response_body" },
};

const DATE_FIELDS = new Set([
  "previousSecretExpiresAt",
  "createdAt",
  "updatedAt",
  "nextAttemptAt",
  "lockedUntil",
  "lastAttemptAt",
  "at",
]);

/** The SQL that creates the tables. Run it once, e.g. in a migration, or call `store.migrate()`. */
export function postgresSchema(tablePrefix = "vector_"): string {
  const p = checkPrefix(tablePrefix);
  return `
create table if not exists ${p}endpoints (
  id text primary key,
  tenant text,
  url text not null,
  description text,
  secret text not null,
  previous_secret text,
  previous_secret_expires_at timestamptz,
  event_types jsonb,
  headers jsonb not null default '{}',
  metadata jsonb not null default '{}',
  enabled boolean not null default true,
  disabled_reason text,
  failure_streak integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists ${p}endpoints_tenant_idx on ${p}endpoints (tenant, created_at desc);

create table if not exists ${p}messages (
  id text primary key,
  tenant text,
  event_type text not null,
  payload jsonb not null,
  idempotency_key text,
  created_at timestamptz not null
);
create unique index if not exists ${p}messages_idempotency_idx
  on ${p}messages ((coalesce(tenant, '')), idempotency_key) where idempotency_key is not null;
create index if not exists ${p}messages_tenant_idx on ${p}messages (tenant, created_at desc);

create table if not exists ${p}deliveries (
  id text primary key,
  message_id text not null references ${p}messages (id) on delete cascade,
  endpoint_id text not null,
  tenant text,
  event_type text not null,
  status text not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  locked_until timestamptz,
  last_attempt_at timestamptz,
  last_status_code integer,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists ${p}deliveries_due_idx on ${p}deliveries (next_attempt_at) where status = 'pending';
create index if not exists ${p}deliveries_message_idx on ${p}deliveries (message_id);
create index if not exists ${p}deliveries_endpoint_idx on ${p}deliveries (endpoint_id, created_at desc);
create index if not exists ${p}deliveries_tenant_idx on ${p}deliveries (tenant, created_at desc);

create table if not exists ${p}attempts (
  id text primary key,
  delivery_id text not null references ${p}deliveries (id) on delete cascade,
  message_id text not null,
  endpoint_id text not null,
  tenant text,
  at timestamptz not null,
  duration_ms integer not null,
  status_code integer,
  success boolean not null,
  error text,
  response_body text
);
create index if not exists ${p}attempts_delivery_idx on ${p}attempts (delivery_id);
create index if not exists ${p}attempts_endpoint_idx on ${p}attempts (endpoint_id, at desc);
create index if not exists ${p}attempts_message_idx on ${p}attempts (message_id);
create index if not exists ${p}attempts_tenant_idx on ${p}attempts (tenant, at desc);
`;
}

function checkPrefix(prefix: string): string {
  if (!/^[a-z_][a-z0-9_]{0,30}$/.test(prefix)) {
    throw new TypeError("tablePrefix may only contain lowercase letters, digits and underscores.");
  }
  return prefix;
}

function toRow<T extends object>(columns: Record<keyof T, Column>, value: Partial<T>) {
  const names: string[] = [];
  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const [key, column] of Object.entries(columns) as [keyof T, Column][]) {
    if (!(key in value)) continue;
    const field = value[key];
    names.push(column.name);
    params.push(column.json ? (field === null ? null : JSON.stringify(field)) : field);
    placeholders.push(column.json ? `$${params.length}::jsonb` : `$${params.length}`);
  }
  return { names, params, placeholders };
}

function fromRow<T>(columns: Record<keyof T, Column>, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(columns) as [string, Column][]) {
    let value = row[column.name];
    if (value === undefined) value = null;
    if (column.json && typeof value === "string") value = JSON.parse(value);
    if (DATE_FIELDS.has(key) && value !== null && !(value instanceof Date)) {
      value = new Date(value as string);
    }
    out[key] = value;
  }
  return out as T;
}

class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];

  add(sql: (placeholder: string) => string, value: unknown) {
    this.params.push(value);
    this.clauses.push(sql(`$${this.params.length}`));
  }

  tenant(column: string, tenant: string | null | undefined) {
    if (tenant === undefined) return;
    if (tenant === null) this.clauses.push(`${column} is null`);
    else this.add((p) => `${column} = ${p}`, tenant);
  }

  sql() {
    return this.clauses.length ? `where ${this.clauses.join(" and ")}` : "";
  }

  limit(limit: number | undefined) {
    this.params.push(Math.min(Math.max(limit ?? 50, 1), 1000));
    return `limit $${this.params.length}`;
  }
}

/** A `VectorStore` on PostgreSQL. Safe with several workers (uses `for update skip locked`). */
export class PostgresStore implements VectorStore {
  private readonly query: PostgresQuery;
  private readonly t: { endpoints: string; messages: string; deliveries: string; attempts: string };
  private readonly prefix: string;

  constructor(options: PostgresStoreOptions) {
    this.query = options.query;
    this.prefix = checkPrefix(options.tablePrefix ?? "vector_");
    this.t = {
      endpoints: `${this.prefix}endpoints`,
      messages: `${this.prefix}messages`,
      deliveries: `${this.prefix}deliveries`,
      attempts: `${this.prefix}attempts`,
    };
  }

  /** Creates the tables and indexes if they do not exist. */
  async migrate(): Promise<void> {
    for (const statement of postgresSchema(this.prefix).split(";")) {
      if (statement.trim()) await this.query(statement, []);
    }
  }

  private async insert<T extends object>(
    table: string,
    columns: Record<keyof T, Column>,
    value: T,
  ) {
    const row = toRow(columns, value);
    await this.query(
      `insert into ${table} (${row.names.join(", ")}) values (${row.placeholders.join(", ")})`,
      row.params,
    );
  }

  private async update<T extends object>(
    table: string,
    columns: Record<keyof T, Column>,
    id: string,
    patch: Partial<T>,
  ): Promise<T | undefined> {
    const { id: _ignored, ...rest } = patch as Partial<T> & { id?: unknown };
    const row = toRow(columns, rest as Partial<T>);
    if (row.names.length === 0) return this.get(table, columns, id);
    const sets = row.names.map((name, i) => `${name} = ${row.placeholders[i]}`);
    const result = await this.query(
      `update ${table} set ${sets.join(", ")} where id = $${row.params.length + 1} returning *`,
      [...row.params, id],
    );
    const first = result.rows[0];
    return first ? fromRow<T>(columns, first) : undefined;
  }

  private async get<T>(table: string, columns: Record<keyof T, Column>, id: string) {
    const result = await this.query(`select * from ${table} where id = $1`, [id]);
    const first = result.rows[0];
    return first ? fromRow<T>(columns, first) : undefined;
  }

  insertEndpoint(endpoint: Endpoint) {
    return this.insert(this.t.endpoints, ENDPOINT_COLUMNS, endpoint);
  }

  updateEndpoint(id: string, patch: Partial<Endpoint>) {
    return this.update(this.t.endpoints, ENDPOINT_COLUMNS, id, patch);
  }

  getEndpoint(id: string) {
    return this.get<Endpoint>(this.t.endpoints, ENDPOINT_COLUMNS, id);
  }

  async deleteEndpoint(id: string) {
    const result = await this.query(`delete from ${this.t.endpoints} where id = $1 returning id`, [
      id,
    ]);
    return result.rows.length > 0;
  }

  async listEndpoints(query: EndpointQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.before) where.add((p) => `created_at < ${p}`, query.before);
    const sql = `select * from ${this.t.endpoints} ${where.sql()} order by created_at desc, id desc ${where.limit(query.limit)}`;
    const result = await this.query(sql, where.params);
    return result.rows.map((row) => fromRow<Endpoint>(ENDPOINT_COLUMNS, row));
  }

  async endpointsForTenant(tenant: string | null) {
    const where = new Where();
    where.tenant("tenant", tenant);
    where.clauses.push("enabled = true");
    const result = await this.query(
      `select * from ${this.t.endpoints} ${where.sql()}`,
      where.params,
    );
    return result.rows.map((row) => fromRow<Endpoint>(ENDPOINT_COLUMNS, row));
  }

  insertMessage(message: Message) {
    return this.insert(this.t.messages, MESSAGE_COLUMNS, message);
  }

  getMessage(id: string) {
    return this.get<Message>(this.t.messages, MESSAGE_COLUMNS, id);
  }

  async findMessageByIdempotencyKey(tenant: string | null, key: string) {
    const result = await this.query(
      `select * from ${this.t.messages} where coalesce(tenant, '') = $1 and idempotency_key = $2`,
      [tenant ?? "", key],
    );
    const first = result.rows[0];
    return first ? fromRow<Message>(MESSAGE_COLUMNS, first) : undefined;
  }

  async listMessages(query: MessageQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.eventType) where.add((p) => `event_type = ${p}`, query.eventType);
    if (query.since) where.add((p) => `created_at >= ${p}`, query.since);
    if (query.before) where.add((p) => `created_at < ${p}`, query.before);
    const sql = `select * from ${this.t.messages} ${where.sql()} order by created_at desc, id desc ${where.limit(query.limit)}`;
    const result = await this.query(sql, where.params);
    return result.rows.map((row) => fromRow<Message>(MESSAGE_COLUMNS, row));
  }

  async insertDeliveries(deliveries: Delivery[]) {
    for (const delivery of deliveries) {
      await this.insert(this.t.deliveries, DELIVERY_COLUMNS, delivery);
    }
  }

  getDelivery(id: string) {
    return this.get<Delivery>(this.t.deliveries, DELIVERY_COLUMNS, id);
  }

  updateDelivery(id: string, patch: Partial<Delivery>) {
    return this.update(this.t.deliveries, DELIVERY_COLUMNS, id, patch);
  }

  async listDeliveries(query: DeliveryQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.messageId) where.add((p) => `message_id = ${p}`, query.messageId);
    if (query.endpointId) where.add((p) => `endpoint_id = ${p}`, query.endpointId);
    if (query.status) where.add((p) => `status = ${p}`, query.status);
    if (query.since) where.add((p) => `created_at >= ${p}`, query.since);
    if (query.before) where.add((p) => `created_at < ${p}`, query.before);
    const sql = `select * from ${this.t.deliveries} ${where.sql()} order by created_at desc, id desc ${where.limit(query.limit)}`;
    const result = await this.query(sql, where.params);
    return result.rows.map((row) => fromRow<Delivery>(DELIVERY_COLUMNS, row));
  }

  async claimDueDeliveries(now: Date, limit: number, lockedUntil: Date) {
    const result = await this.query(
      `update ${this.t.deliveries} set locked_until = $3
       where id in (
         select id from ${this.t.deliveries}
         where status = 'pending' and next_attempt_at <= $1
           and (locked_until is null or locked_until <= $1)
         order by next_attempt_at
         limit $2
         for update skip locked
       )
       returning *`,
      [now, limit, lockedUntil],
    );
    return result.rows.map((row) => fromRow<Delivery>(DELIVERY_COLUMNS, row));
  }

  insertAttempt(attempt: Attempt) {
    return this.insert(this.t.attempts, ATTEMPT_COLUMNS, attempt);
  }

  async listAttempts(query: AttemptQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.deliveryId) where.add((p) => `delivery_id = ${p}`, query.deliveryId);
    if (query.messageId) where.add((p) => `message_id = ${p}`, query.messageId);
    if (query.endpointId) where.add((p) => `endpoint_id = ${p}`, query.endpointId);
    if (query.since) where.add((p) => `at >= ${p}`, query.since);
    if (query.before) where.add((p) => `at < ${p}`, query.before);
    const sql = `select * from ${this.t.attempts} ${where.sql()} order by at desc, id desc ${where.limit(query.limit)}`;
    const result = await this.query(sql, where.params);
    return result.rows.map((row) => fromRow<Attempt>(ATTEMPT_COLUMNS, row));
  }
}

/** Creates a PostgreSQL store. Call `await store.migrate()` once, or run `postgresSchema()` yourself. */
export function createPostgresStore(options: PostgresStoreOptions): PostgresStore {
  return new PostgresStore(options);
}

/**
 * Remembers handled webhook ids in a table, for receivers with several processes or restarts. Call
 * `await deduper.migrate()` once, and `deduper.prune()` now and then (e.g. daily) to drop old ids.
 */
export function postgresDeduper(options: { query: PostgresQuery } & SqlDeduperOptions): SqlDeduper {
  const { query } = options;
  const driver: DedupeDriver = {
    run: async (sql) => void (await query(sql, [])),
    deleteExpired: async (table, id, nowMs) =>
      void (await query(`delete from ${table} where id = $1 and expires_at <= $2`, [id, nowMs])),
    insert: async (table, id, expiresMs) =>
      (
        await query(
          `insert into ${table} (id, expires_at) values ($1, $2) on conflict (id) do nothing returning id`,
          [id, expiresMs],
        )
      ).rows.length === 1,
    remove: async (table, id) => void (await query(`delete from ${table} where id = $1`, [id])),
    deleteAllExpired: async (table, nowMs) =>
      (await query(`delete from ${table} where expires_at <= $1 returning id`, [nowMs])).rows
        .length,
  };
  return sqlDeduper(
    driver,
    (table) => [
      `create table if not exists ${table} (id text primary key, expires_at bigint not null)`,
      `create index if not exists ${table}_expires on ${table} (expires_at)`,
    ],
    options,
  );
}

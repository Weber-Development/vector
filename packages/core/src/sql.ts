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

// Shared base of the SQLite and MySQL stores. Both use `?` placeholders and plain column types:
// dates are milliseconds since the epoch, booleans 0/1 and JSON a text column, so the same SQL
// works on both and no driver-specific type parsing is involved.

/** Runs one statement: rows for a select, the number of changed rows for everything else. */
export interface SqlExecutor {
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<number>;
}

type Column = { name: string; kind?: "json" | "date" | "bool" };

const ENDPOINT_COLUMNS: Record<keyof Endpoint, Column> = {
  id: { name: "id" },
  tenant: { name: "tenant" },
  url: { name: "url" },
  description: { name: "description" },
  secret: { name: "secret" },
  previousSecret: { name: "previous_secret" },
  previousSecretExpiresAt: { name: "previous_secret_expires_at", kind: "date" },
  eventTypes: { name: "event_types", kind: "json" },
  headers: { name: "headers", kind: "json" },
  metadata: { name: "metadata", kind: "json" },
  enabled: { name: "enabled", kind: "bool" },
  disabledReason: { name: "disabled_reason" },
  failureStreak: { name: "failure_streak" },
  createdAt: { name: "created_at", kind: "date" },
  updatedAt: { name: "updated_at", kind: "date" },
};

const MESSAGE_COLUMNS: Record<keyof Message, Column> = {
  id: { name: "id" },
  tenant: { name: "tenant" },
  eventType: { name: "event_type" },
  payload: { name: "payload", kind: "json" },
  idempotencyKey: { name: "idempotency_key" },
  createdAt: { name: "created_at", kind: "date" },
};

const DELIVERY_COLUMNS: Record<keyof Delivery, Column> = {
  id: { name: "id" },
  messageId: { name: "message_id" },
  endpointId: { name: "endpoint_id" },
  tenant: { name: "tenant" },
  eventType: { name: "event_type" },
  status: { name: "status" },
  attempts: { name: "attempts" },
  nextAttemptAt: { name: "next_attempt_at", kind: "date" },
  lockedUntil: { name: "locked_until", kind: "date" },
  lastAttemptAt: { name: "last_attempt_at", kind: "date" },
  lastStatusCode: { name: "last_status_code" },
  lastError: { name: "last_error" },
  createdAt: { name: "created_at", kind: "date" },
  updatedAt: { name: "updated_at", kind: "date" },
};

const ATTEMPT_COLUMNS: Record<keyof Attempt, Column> = {
  id: { name: "id" },
  deliveryId: { name: "delivery_id" },
  messageId: { name: "message_id" },
  endpointId: { name: "endpoint_id" },
  tenant: { name: "tenant" },
  at: { name: "at", kind: "date" },
  durationMs: { name: "duration_ms" },
  statusCode: { name: "status_code" },
  success: { name: "success", kind: "bool" },
  error: { name: "error" },
  responseBody: { name: "response_body" },
};

export function checkPrefix(prefix: string): string {
  if (!/^[a-z_][a-z0-9_]{0,30}$/.test(prefix)) {
    throw new TypeError("tablePrefix may only contain lowercase letters, digits and underscores.");
  }
  return prefix;
}

/** A value as the drivers take it: no booleans, no undefined, no Date. */
function param(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function toRow<T extends object>(columns: Record<keyof T, Column>, value: Partial<T>) {
  const names: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(columns) as [keyof T, Column][]) {
    if (!(key in value)) continue;
    const field = value[key];
    names.push(column.name);
    params.push(column.kind === "json" && field != null ? JSON.stringify(field) : param(field));
  }
  return { names, params };
}

function fromRow<T>(columns: Record<keyof T, Column>, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(columns) as [string, Column][]) {
    let value = row[column.name] ?? null;
    if (value !== null) {
      if (column.kind === "json" && typeof value === "string") value = JSON.parse(value);
      else if (column.kind === "date") value = new Date(Number(value));
      else if (column.kind === "bool") value = Boolean(Number(value));
      else if (typeof value === "bigint") value = Number(value);
    }
    out[key] = value;
  }
  return out as T;
}

class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];

  add(clause: string, value: unknown) {
    this.clauses.push(clause);
    this.params.push(param(value));
  }

  tenant(column: string, tenant: string | null | undefined) {
    if (tenant === undefined) return;
    if (tenant === null) this.clauses.push(`${column} is null`);
    else this.add(`${column} = ?`, tenant);
  }

  sql() {
    return this.clauses.length ? `where ${this.clauses.join(" and ")}` : "";
  }
}

/** Inlined, so drivers that cannot bind LIMIT (mysql2 `execute`) work too. */
function limit(value: number | undefined): string {
  return `limit ${Math.min(Math.max(Math.trunc(Number(value) || 50), 1), 1000)}`;
}

export interface SqlDialect {
  /** Statements that create the tables and indexes, each safe to run again. */
  schema(prefix: string): string[];
  /**
   * Marks up to `limit` due deliveries with `lockToken` and `lockedUntil` in one statement, so
   * two workers never mark the same row. Parameters: lockedUntil, lockToken, now, now.
   */
  claim(table: string, limit: number): string;
}

/** The common implementation behind `SqliteStore` and `MysqlStore`. */
export class SqlStore implements VectorStore {
  protected readonly t: {
    endpoints: string;
    messages: string;
    deliveries: string;
    attempts: string;
  };

  constructor(
    private readonly db: SqlExecutor,
    private readonly dialect: SqlDialect,
    protected readonly prefix: string,
  ) {
    checkPrefix(prefix);
    this.t = {
      endpoints: `${prefix}endpoints`,
      messages: `${prefix}messages`,
      deliveries: `${prefix}deliveries`,
      attempts: `${prefix}attempts`,
    };
  }

  /** Creates the tables and indexes if they do not exist. */
  async migrate(): Promise<void> {
    for (const statement of this.dialect.schema(this.prefix)) {
      await this.db.run(statement, []);
    }
  }

  private async insert<T extends object>(
    table: string,
    columns: Record<keyof T, Column>,
    value: T,
  ) {
    const row = toRow(columns, value);
    const placeholders = row.names.map(() => "?").join(", ");
    await this.db.run(
      `insert into ${table} (${row.names.join(", ")}) values (${placeholders})`,
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
    if (row.names.length > 0) {
      const sets = row.names.map((name) => `${name} = ?`).join(", ");
      await this.db.run(`update ${table} set ${sets} where id = ?`, [...row.params, id]);
    }
    return this.get(table, columns, id);
  }

  private async get<T>(table: string, columns: Record<keyof T, Column>, id: string) {
    const [first] = await this.db.all(`select * from ${table} where id = ?`, [id]);
    return first ? fromRow<T>(columns, first) : undefined;
  }

  private async list<T>(
    table: string,
    columns: Record<keyof T, Column>,
    where: Where,
    order: string,
    max: number | undefined,
  ) {
    const rows = await this.db.all(
      `select * from ${table} ${where.sql()} order by ${order} ${limit(max)}`,
      where.params,
    );
    return rows.map((row) => fromRow<T>(columns, row));
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
    return (await this.db.run(`delete from ${this.t.endpoints} where id = ?`, [id])) > 0;
  }

  listEndpoints(query: EndpointQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.before) where.add("created_at < ?", query.before);
    return this.list<Endpoint>(
      this.t.endpoints,
      ENDPOINT_COLUMNS,
      where,
      "created_at desc, id desc",
      query.limit,
    );
  }

  async endpointsForTenant(tenant: string | null) {
    const where = new Where();
    where.tenant("tenant", tenant);
    where.clauses.push("enabled = 1");
    const rows = await this.db.all(
      `select * from ${this.t.endpoints} ${where.sql()}`,
      where.params,
    );
    return rows.map((row) => fromRow<Endpoint>(ENDPOINT_COLUMNS, row));
  }

  insertMessage(message: Message) {
    return this.insert(this.t.messages, MESSAGE_COLUMNS, message);
  }

  getMessage(id: string) {
    return this.get<Message>(this.t.messages, MESSAGE_COLUMNS, id);
  }

  async findMessageByIdempotencyKey(tenant: string | null, key: string) {
    const [first] = await this.db.all(
      `select * from ${this.t.messages} where coalesce(tenant, '') = ? and idempotency_key = ?`,
      [tenant ?? "", key],
    );
    return first ? fromRow<Message>(MESSAGE_COLUMNS, first) : undefined;
  }

  listMessages(query: MessageQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.eventType) where.add("event_type = ?", query.eventType);
    if (query.since) where.add("created_at >= ?", query.since);
    if (query.before) where.add("created_at < ?", query.before);
    return this.list<Message>(
      this.t.messages,
      MESSAGE_COLUMNS,
      where,
      "created_at desc, id desc",
      query.limit,
    );
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

  listDeliveries(query: DeliveryQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.messageId) where.add("message_id = ?", query.messageId);
    if (query.endpointId) where.add("endpoint_id = ?", query.endpointId);
    if (query.status) where.add("status = ?", query.status);
    if (query.since) where.add("created_at >= ?", query.since);
    if (query.before) where.add("created_at < ?", query.before);
    return this.list<Delivery>(
      this.t.deliveries,
      DELIVERY_COLUMNS,
      where,
      "created_at desc, id desc",
      query.limit,
    );
  }

  async claimDueDeliveries(now: Date, max: number, lockedUntil: Date) {
    const count = Math.min(Math.max(Math.trunc(max), 1), 1000);
    const token = globalThis.crypto.randomUUID();
    const changed = await this.db.run(this.dialect.claim(this.t.deliveries, count), [
      lockedUntil.getTime(),
      token,
      now.getTime(),
      now.getTime(),
    ]);
    if (changed === 0) return [];
    const rows = await this.db.all(
      `select * from ${this.t.deliveries} where lock_token = ? order by next_attempt_at`,
      [token],
    );
    return rows.map((row) => fromRow<Delivery>(DELIVERY_COLUMNS, row));
  }

  insertAttempt(attempt: Attempt) {
    return this.insert(this.t.attempts, ATTEMPT_COLUMNS, attempt);
  }

  listAttempts(query: AttemptQuery) {
    const where = new Where();
    where.tenant("tenant", query.tenant);
    if (query.deliveryId) where.add("delivery_id = ?", query.deliveryId);
    if (query.messageId) where.add("message_id = ?", query.messageId);
    if (query.endpointId) where.add("endpoint_id = ?", query.endpointId);
    if (query.since) where.add("at >= ?", query.since);
    if (query.before) where.add("at < ?", query.before);
    return this.list<Attempt>(
      this.t.attempts,
      ATTEMPT_COLUMNS,
      where,
      "at desc, id desc",
      query.limit,
    );
  }
}

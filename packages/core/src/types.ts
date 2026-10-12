/** One comparison on a field of the payload, e.g. `{ path: "amount", op: "gte", value: 100 }`. */
export interface FilterCondition {
  /** Dot-separated path into the payload (`data` of the delivered body), e.g. `customer.plan`. */
  path: string;
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin" | "exists" | "prefix" | "contains";
  /** The value to compare with. For `in` and `nin` an array, for `exists` a boolean (default true). */
  value?: unknown;
}

/** A condition on the payload, or `and`, `or` and `not` of other filters. */
export type PayloadFilter =
  | FilterCondition
  | { and: PayloadFilter[] }
  | { or: PayloadFilter[] }
  | { not: PayloadFilter };

export interface Endpoint {
  id: string;
  /** Your customer, team or project the endpoint belongs to. Messages only reach endpoints of the same tenant. */
  tenant: string | null;
  url: string;
  description: string | null;
  /** Current signing secret (`whsec_...`). */
  secret: string;
  /** Previous secret that still signs during a rotation, and until when. */
  previousSecret: string | null;
  previousSecretExpiresAt: Date | null;
  /** Event types this endpoint receives. `null` means all. Supports `invoice.*` and `*`. */
  eventTypes: string[] | null;
  /** Only messages whose payload matches reach this endpoint. `null` means all. */
  filter: PayloadFilter | null;
  /** Extra headers sent with every request to this endpoint. */
  headers: Record<string, string>;
  metadata: Record<string, string>;
  enabled: boolean;
  disabledReason: string | null;
  /** Deliveries in a row that gave up. Reset by the next success. */
  failureStreak: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  tenant: string | null;
  eventType: string;
  payload: unknown;
  idempotencyKey: string | null;
  /** Messages with the same key reach each endpoint one after the other, in the order sent. */
  orderingKey: string | null;
  createdAt: Date;
}

export type DeliveryStatus = "pending" | "succeeded" | "failed" | "cancelled";

/** One message on its way to one endpoint, with all of its attempts. */
export interface Delivery {
  id: string;
  messageId: string;
  endpointId: string;
  tenant: string | null;
  eventType: string;
  /** Copied from the message. A delivery waits while an earlier one with the same key is pending. */
  orderingKey: string | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lockedUntil: Date | null;
  lastAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One HTTP request to an endpoint. */
export interface Attempt {
  id: string;
  deliveryId: string;
  messageId: string;
  endpointId: string;
  tenant: string | null;
  at: Date;
  durationMs: number;
  statusCode: number | null;
  success: boolean;
  error: string | null;
  /** Start of the response body, cut to `maxResponseBytes`. */
  responseBody: string | null;
}

/** The data layout version of the tables the bundled stores create. */
export const SCHEMA_VERSION = 2;

export interface Page {
  limit?: number;
  /** Only items created strictly before this date (for paging backwards). */
  before?: Date;
}

export interface EndpointQuery extends Page {
  tenant?: string | null;
}

export interface MessageQuery extends Page {
  tenant?: string | null;
  eventType?: string;
  since?: Date;
  /** With `before`: also items created exactly at `before` whose id is smaller. For stable paging. */
  beforeId?: string;
}

export interface DeliveryQuery extends Page {
  tenant?: string | null;
  messageId?: string;
  endpointId?: string;
  status?: DeliveryStatus;
  since?: Date;
}

export interface AttemptQuery extends Page {
  tenant?: string | null;
  deliveryId?: string;
  messageId?: string;
  endpointId?: string;
  since?: Date;
}

/**
 * Where Vector keeps endpoints, messages, deliveries and attempts. Use `MemoryStore` for tests
 * and demos, `createPostgresStore` from `@sweberdev/vector/postgres` in production, or implement
 * the interface for your own database. Lists are ordered newest first.
 */
export interface VectorStore {
  insertEndpoint(endpoint: Endpoint): Promise<void>;
  updateEndpoint(id: string, patch: Partial<Endpoint>): Promise<Endpoint | undefined>;
  getEndpoint(id: string): Promise<Endpoint | undefined>;
  deleteEndpoint(id: string): Promise<boolean>;
  listEndpoints(query: EndpointQuery): Promise<Endpoint[]>;
  /** Enabled endpoints of a tenant, used to fan out a message. */
  endpointsForTenant(tenant: string | null): Promise<Endpoint[]>;

  insertMessage(message: Message): Promise<void>;
  getMessage(id: string): Promise<Message | undefined>;
  findMessageByIdempotencyKey(tenant: string | null, key: string): Promise<Message | undefined>;
  listMessages(query: MessageQuery): Promise<Message[]>;

  insertDeliveries(deliveries: Delivery[]): Promise<void>;
  getDelivery(id: string): Promise<Delivery | undefined>;
  updateDelivery(id: string, patch: Partial<Delivery>): Promise<Delivery | undefined>;
  listDeliveries(query: DeliveryQuery): Promise<Delivery[]>;
  /**
   * Atomically picks up to `limit` pending deliveries that are due at `now` and not locked, and
   * locks them until `lockedUntil`. Two workers must never claim the same delivery. A delivery
   * with an `orderingKey` is only claimed when no earlier delivery (older `createdAt`, ties by
   * `id`) to the same endpoint with the same key is still `pending`.
   */
  claimDueDeliveries(now: Date, limit: number, lockedUntil: Date): Promise<Delivery[]>;

  /**
   * Deletes up to `limit` messages created before `before`, with their deliveries and attempts,
   * oldest first, and returns how many messages it deleted. Messages with a pending delivery stay.
   */
  deleteMessagesBefore(before: Date, limit: number): Promise<number>;
  /** The version of the data layout this store has, 0 when it was never migrated. */
  schemaVersion(): Promise<number>;

  insertAttempt(attempt: Attempt): Promise<void>;
  listAttempts(query: AttemptQuery): Promise<Attempt[]>;
}

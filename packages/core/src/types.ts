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
   * locks them until `lockedUntil`. Two workers must never claim the same delivery.
   */
  claimDueDeliveries(now: Date, limit: number, lockedUntil: Date): Promise<Delivery[]>;

  insertAttempt(attempt: Attempt): Promise<void>;
  listAttempts(query: AttemptQuery): Promise<Attempt[]>;
}

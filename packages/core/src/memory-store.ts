import type {
  Attempt,
  AttemptQuery,
  Delivery,
  DeliveryQuery,
  Endpoint,
  EndpointQuery,
  Message,
  MessageQuery,
  Page,
  VectorStore,
} from "./types";
import { SCHEMA_VERSION } from "./types";

function page<T extends { id?: string; createdAt?: Date; at?: Date }>(
  items: T[],
  query: Page & { beforeId?: string },
): T[] {
  const time = (item: T) => (item.createdAt ?? item.at ?? new Date(0)).getTime();
  const before = query.before?.getTime();
  const after = (item: T) =>
    before === undefined ||
    time(item) < before ||
    (query.beforeId !== undefined && time(item) === before && (item.id ?? "") < query.beforeId);
  return items
    .filter(after)
    .sort((a, b) => time(b) - time(a) || ((b.id ?? "") < (a.id ?? "") ? -1 : 1))
    .slice(0, query.limit ?? 50);
}

function matchesTenant(value: string | null, tenant: string | null | undefined): boolean {
  return tenant === undefined || value === tenant;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Keeps everything in memory. Good for tests, demos and single-process prototypes. */
export class MemoryStore implements VectorStore {
  private endpoints = new Map<string, Endpoint>();
  private messages = new Map<string, Message>();
  private deliveries = new Map<string, Delivery>();
  private attempts: Attempt[] = [];

  async insertEndpoint(endpoint: Endpoint): Promise<void> {
    this.endpoints.set(endpoint.id, clone(endpoint));
  }

  async updateEndpoint(id: string, patch: Partial<Endpoint>): Promise<Endpoint | undefined> {
    const current = this.endpoints.get(id);
    if (!current) return undefined;
    const next = { ...current, ...clone(patch), id };
    this.endpoints.set(id, next);
    return clone(next);
  }

  async getEndpoint(id: string): Promise<Endpoint | undefined> {
    const endpoint = this.endpoints.get(id);
    return endpoint && clone(endpoint);
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    return this.endpoints.delete(id);
  }

  async listEndpoints(query: EndpointQuery): Promise<Endpoint[]> {
    const items = [...this.endpoints.values()].filter((e) => matchesTenant(e.tenant, query.tenant));
    return page(items, query).map(clone);
  }

  async endpointsForTenant(tenant: string | null): Promise<Endpoint[]> {
    return [...this.endpoints.values()].filter((e) => e.enabled && e.tenant === tenant).map(clone);
  }

  async insertMessage(message: Message): Promise<void> {
    this.messages.set(message.id, clone(message));
  }

  async getMessage(id: string): Promise<Message | undefined> {
    const message = this.messages.get(id);
    return message && clone(message);
  }

  async findMessageByIdempotencyKey(
    tenant: string | null,
    key: string,
  ): Promise<Message | undefined> {
    for (const message of this.messages.values()) {
      if (message.tenant === tenant && message.idempotencyKey === key) return clone(message);
    }
    return undefined;
  }

  async listMessages(query: MessageQuery): Promise<Message[]> {
    const items = [...this.messages.values()].filter(
      (m) =>
        matchesTenant(m.tenant, query.tenant) &&
        (query.eventType === undefined || m.eventType === query.eventType) &&
        (query.since === undefined || m.createdAt >= query.since),
    );
    return page(items, query).map(clone);
  }

  async insertDeliveries(deliveries: Delivery[]): Promise<void> {
    for (const delivery of deliveries) this.deliveries.set(delivery.id, clone(delivery));
  }

  async getDelivery(id: string): Promise<Delivery | undefined> {
    const delivery = this.deliveries.get(id);
    return delivery && clone(delivery);
  }

  async updateDelivery(id: string, patch: Partial<Delivery>): Promise<Delivery | undefined> {
    const current = this.deliveries.get(id);
    if (!current) return undefined;
    const next = { ...current, ...clone(patch), id };
    this.deliveries.set(id, next);
    return clone(next);
  }

  async listDeliveries(query: DeliveryQuery): Promise<Delivery[]> {
    const items = [...this.deliveries.values()].filter(
      (d) =>
        matchesTenant(d.tenant, query.tenant) &&
        (query.messageId === undefined || d.messageId === query.messageId) &&
        (query.endpointId === undefined || d.endpointId === query.endpointId) &&
        (query.status === undefined || d.status === query.status) &&
        (query.since === undefined || d.createdAt >= query.since),
    );
    return page(items, query).map(clone);
  }

  /** An earlier delivery to the same endpoint with the same ordering key is still pending. */
  private blockedByEarlier(delivery: Delivery): boolean {
    if (delivery.orderingKey === null) return false;
    for (const other of this.deliveries.values()) {
      if (
        other.status === "pending" &&
        other.endpointId === delivery.endpointId &&
        other.orderingKey === delivery.orderingKey &&
        (other.createdAt < delivery.createdAt ||
          (other.createdAt.getTime() === delivery.createdAt.getTime() && other.id < delivery.id))
      ) {
        return true;
      }
    }
    return false;
  }

  async claimDueDeliveries(now: Date, limit: number, lockedUntil: Date): Promise<Delivery[]> {
    const due = [...this.deliveries.values()]
      .filter(
        (d) =>
          d.status === "pending" &&
          d.nextAttemptAt !== null &&
          d.nextAttemptAt <= now &&
          (d.lockedUntil === null || d.lockedUntil <= now) &&
          !this.blockedByEarlier(d),
      )
      .sort((a, b) => (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0))
      .slice(0, limit);
    for (const delivery of due) delivery.lockedUntil = lockedUntil;
    return due.map(clone);
  }

  async deleteMessagesBefore(before: Date, limit: number): Promise<number> {
    const pending = new Set<string>();
    for (const d of this.deliveries.values()) if (d.status === "pending") pending.add(d.messageId);
    const old = [...this.messages.values()]
      .filter((m) => m.createdAt < before && !pending.has(m.id))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
    const ids = new Set(old.map((m) => m.id));
    for (const id of ids) this.messages.delete(id);
    for (const [id, d] of this.deliveries) if (ids.has(d.messageId)) this.deliveries.delete(id);
    this.attempts = this.attempts.filter((a) => !ids.has(a.messageId));
    return ids.size;
  }

  async schemaVersion(): Promise<number> {
    return SCHEMA_VERSION;
  }

  async insertAttempt(attempt: Attempt): Promise<void> {
    this.attempts.push(clone(attempt));
  }

  async listAttempts(query: AttemptQuery): Promise<Attempt[]> {
    const items = this.attempts.filter(
      (a) =>
        matchesTenant(a.tenant, query.tenant) &&
        (query.deliveryId === undefined || a.deliveryId === query.deliveryId) &&
        (query.messageId === undefined || a.messageId === query.messageId) &&
        (query.endpointId === undefined || a.endpointId === query.endpointId) &&
        (query.since === undefined || a.at >= query.since),
    );
    return page(items, query).map(clone);
  }
}

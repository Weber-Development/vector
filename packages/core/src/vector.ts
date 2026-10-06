import { assertKey, generateKeyPair, isPublicKey, isSecretKey, publicKeyFor } from "./asymmetric";
import { createId } from "./encoding";
import { assertEventType, assertEventTypeFilter, endpointWants } from "./event-types";
import { MemoryStore } from "./memory-store";
import { generateSecret, secretToBytes, signHeaders } from "./signature";
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
import { assertDeliverableUrl, type UrlPolicy } from "./url-guard";

/**
 * Seconds to wait after each failed attempt. Eight attempts over about 27 hours: immediately,
 * then after 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours and 10 hours.
 */
export const DEFAULT_RETRY_SCHEDULE: readonly number[] = [5, 300, 1800, 7200, 18000, 36000, 36000];

const RESERVED_HEADERS = new Set([
  "content-type",
  "content-length",
  "host",
  "user-agent",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "transfer-encoding",
  "connection",
]);

export interface VectorOptions {
  /** Where data is kept. Default: a new `MemoryStore` (lost on restart). */
  store?: VectorStore;
  /** Seconds to wait after each failed attempt; its length + 1 is the number of attempts. */
  retrySchedule?: readonly number[];
  /** Timeout per HTTP request in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** How much of a response body is stored per attempt, in bytes. Default 2048. */
  maxResponseBytes?: number;
  /** Largest payload `send` accepts, in bytes of JSON. Default 256 KiB. */
  maxPayloadBytes?: number;
  /** User-Agent header. Default `Vector-Webhooks/1`. */
  userAgent?: string;
  /** Which endpoint URLs are allowed. By default only public https URLs. */
  urlPolicy?: UrlPolicy;
  /** Disable an endpoint after this many deliveries in a row gave up. 0 never disables. Default 10. */
  disableEndpointAfter?: number;
  /** Disable an endpoint when it answers 410 Gone. Default true. */
  disableOnGone?: boolean;
  /** How long the previous secret keeps signing after a rotation, in seconds. Default 24 hours. */
  secretRotationGraceSeconds?: number;
  /**
   * Signature scheme for new endpoints: "hmac" (`v1`, a shared `whsec_` secret) or "ed25519"
   * (`v1a`, a `whsk_` secret key; receivers verify with the public key). Default "hmac".
   */
  signing?: SigningScheme;
  /** Custom fetch, for tests or proxies. */
  fetch?: typeof fetch;
  /** Clock, for tests. */
  now?: () => Date;
  /** Random number in [0, 1) for retry jitter, for tests. */
  random?: () => number;
  /**
   * Wrap payloads as `{ type, timestamp, data }` (Standard Webhooks). Set to false to send the
   * payload as the whole body, like Svix does. Default true.
   */
  envelope?: boolean;
  /** Called for errors in listeners and the background worker. Default `console.error`. */
  onError?: (error: unknown) => void;
}

export interface CreateEndpointInput {
  url: string;
  tenant?: string | null;
  description?: string | null;
  eventTypes?: string[] | null;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  /**
   * Bring your own `whsec_` secret or `whsk_` Ed25519 secret key, e.g. when migrating.
   * Default: a new random one of the `signing` scheme.
   */
  secret?: string;
  /** Signature scheme of a new secret. Default: the `signing` option. Ignored with `secret`. */
  signing?: SigningScheme;
  enabled?: boolean;
}

export type SigningScheme = "hmac" | "ed25519";

/** Public keys of an Ed25519 endpoint, for its receivers. */
export interface EndpointPublicKeys {
  publicKey: string;
  /** The public key of the previous secret key while it still signs after a rotation. */
  previousPublicKey: string | null;
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  eventTypes?: string[] | null;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  enabled?: boolean;
}

export interface SendInput {
  eventType: string;
  /** Any JSON value. Sent as `data` in the body `{ type, timestamp, data }`. */
  payload: unknown;
  tenant?: string | null;
  /** Sending twice with the same key (per tenant) creates only one message. */
  idempotencyKey?: string;
  /** Only deliver to these endpoints (they must still match tenant and event type). */
  endpointIds?: string[];
  /** Make the first attempt right away and wait for it, instead of leaving it to the worker. */
  deliverNow?: boolean;
}

export interface SendResult {
  message: Message;
  deliveries: Delivery[];
  /** True when the idempotency key was seen before and nothing new was created. */
  duplicate: boolean;
}

export interface ProcessOptions {
  /** Deliveries to pick up in one pass. Default 50. */
  limit?: number;
  /** Requests in parallel. Default 10. */
  concurrency?: number;
}

export interface ProcessResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  cancelled: number;
}

export interface WorkerOptions extends ProcessOptions {
  /** Pause between passes when there was nothing to do, in milliseconds. Default 1000. */
  intervalMs?: number;
}

export interface Worker {
  stop(): Promise<void>;
}

export interface VectorEvents {
  attempt: { attempt: Attempt; delivery: Delivery; endpoint: Endpoint; message: Message };
  "delivery.succeeded": { delivery: Delivery; endpoint: Endpoint; message: Message };
  /** All attempts are used up, or the endpoint is gone. */
  "delivery.failed": { delivery: Delivery; endpoint: Endpoint; message: Message };
  "endpoint.disabled": { endpoint: Endpoint; reason: string };
}

type Listener<K extends keyof VectorEvents> = (event: VectorEvents[K]) => void | Promise<void>;

type Outcome = keyof Omit<ProcessResult, "claimed">;

export interface TenantScope {
  /** Restrict the lookup to this tenant; other tenants' items are treated as missing. */
  tenant?: string | null;
}

function inTenant(item: { tenant: string | null } | undefined, scope?: TenantScope) {
  if (!item) return false;
  return scope?.tenant === undefined || item.tenant === scope.tenant;
}

function validateHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower)) {
      throw new TypeError(`Invalid header name "${name}".`);
    }
    if (RESERVED_HEADERS.has(lower)) {
      throw new TypeError(`The header "${name}" is set by Vector and cannot be overridden.`);
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new TypeError(`Invalid value for header "${name}".`);
    }
    out[lower] = value;
  }
  return out;
}

function validateEventTypes(eventTypes: string[] | null | undefined): string[] | null {
  if (eventTypes === undefined || eventTypes === null) return null;
  for (const filter of eventTypes) assertEventTypeFilter(filter);
  return [...new Set(eventTypes)];
}

function validateSecret(secret: string): string {
  if (isPublicKey(secret)) {
    throw new TypeError("Pass the whsk_ secret key; the whpk_ public key cannot sign.");
  }
  if (isSecretKey(secret)) {
    assertKey(secret);
    return secret;
  }
  const bytes = secretToBytes(secret);
  if (bytes.length < 24)
    throw new TypeError("Secrets must be at least 24 bytes (whsec_ + base64).");
  return secret;
}

async function newSecret(scheme: SigningScheme): Promise<string> {
  if (scheme === "ed25519") return (await generateKeyPair()).secretKey;
  if (scheme !== "hmac") throw new TypeError('signing must be "hmac" or "ed25519".');
  return generateSecret();
}

async function readLimited(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, all.length - offset);
    all.set(part, offset);
    offset += part.length;
    if (offset >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "Timed out";
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

/** The webhook sender. Create one per process and share it. */
export class Vector {
  readonly store: VectorStore;
  private readonly options: Required<
    Omit<VectorOptions, "store" | "urlPolicy" | "fetch" | "onError">
  > & { urlPolicy: UrlPolicy };
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (error: unknown) => void;
  private readonly listeners = new Map<keyof VectorEvents, Set<Listener<never>>>();

  constructor(options: VectorOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.options = {
      retrySchedule: options.retrySchedule ?? DEFAULT_RETRY_SCHEDULE,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxResponseBytes: options.maxResponseBytes ?? 2048,
      maxPayloadBytes: options.maxPayloadBytes ?? 256 * 1024,
      userAgent: options.userAgent ?? "Vector-Webhooks/1",
      urlPolicy: options.urlPolicy ?? {},
      disableEndpointAfter: options.disableEndpointAfter ?? 10,
      disableOnGone: options.disableOnGone ?? true,
      secretRotationGraceSeconds: options.secretRotationGraceSeconds ?? 86_400,
      envelope: options.envelope ?? true,
      signing: options.signing ?? "hmac",
      now: options.now ?? (() => new Date()),
      random: options.random ?? Math.random,
    };
    if (this.options.retrySchedule.some((s) => !(s >= 0))) {
      throw new RangeError("retrySchedule must contain non-negative numbers of seconds.");
    }
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.onError = options.onError ?? ((error) => console.error("[vector]", error));
  }

  /** Subscribe to delivery events. Returns a function that unsubscribes. */
  on<K extends keyof VectorEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  private async emit<K extends keyof VectorEvents>(event: K, data: VectorEvents[K]) {
    const set = this.listeners.get(event);
    if (!set) return;
    await Promise.all(
      [...set].map(async (listener) => {
        try {
          await (listener as Listener<K>)(data);
        } catch (error) {
          this.onError(error);
        }
      }),
    );
  }

  private now() {
    return this.options.now();
  }

  // ---------------------------------------------------------------- endpoints

  readonly endpoints = {
    create: async (input: CreateEndpointInput): Promise<Endpoint> => {
      await assertDeliverableUrl(input.url, this.options.urlPolicy);
      const now = this.now();
      const endpoint: Endpoint = {
        id: createId("ep", now.getTime()),
        tenant: input.tenant ?? null,
        url: input.url,
        description: input.description ?? null,
        secret: input.secret
          ? validateSecret(input.secret)
          : await newSecret(input.signing ?? this.options.signing),
        previousSecret: null,
        previousSecretExpiresAt: null,
        eventTypes: validateEventTypes(input.eventTypes),
        headers: validateHeaders(input.headers),
        metadata: { ...(input.metadata ?? {}) },
        enabled: input.enabled ?? true,
        disabledReason: input.enabled === false ? "Disabled when created" : null,
        failureStreak: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.insertEndpoint(endpoint);
      return endpoint;
    },

    get: async (id: string, scope?: TenantScope): Promise<Endpoint | undefined> => {
      const endpoint = await this.store.getEndpoint(id);
      return inTenant(endpoint, scope) ? endpoint : undefined;
    },

    list: (query: EndpointQuery = {}): Promise<Endpoint[]> => this.store.listEndpoints(query),

    update: async (
      id: string,
      input: UpdateEndpointInput,
      scope?: TenantScope,
    ): Promise<Endpoint | undefined> => {
      if (!(await this.endpoints.get(id, scope))) return undefined;
      const patch: Partial<Endpoint> = { updatedAt: this.now() };
      if (input.url !== undefined) {
        await assertDeliverableUrl(input.url, this.options.urlPolicy);
        patch.url = input.url;
      }
      if (input.description !== undefined) patch.description = input.description;
      if (input.eventTypes !== undefined) patch.eventTypes = validateEventTypes(input.eventTypes);
      if (input.headers !== undefined) patch.headers = validateHeaders(input.headers);
      if (input.metadata !== undefined) patch.metadata = { ...input.metadata };
      if (input.enabled !== undefined) {
        patch.enabled = input.enabled;
        patch.disabledReason = input.enabled ? null : "Disabled manually";
        if (input.enabled) patch.failureStreak = 0;
      }
      return this.store.updateEndpoint(id, patch);
    },

    delete: async (id: string, scope?: TenantScope): Promise<boolean> => {
      if (!(await this.endpoints.get(id, scope))) return false;
      return this.store.deleteEndpoint(id);
    },

    /**
     * The public keys receivers verify with, for an endpoint that signs with Ed25519. `undefined`
     * for unknown endpoints; `null` for endpoints with an HMAC secret.
     */
    publicKey: async (
      id: string,
      scope: TenantScope = {},
    ): Promise<EndpointPublicKeys | null | undefined> => {
      const endpoint = await this.endpoints.get(id, scope);
      if (!endpoint) return undefined;
      if (!isSecretKey(endpoint.secret)) return null;
      const previousValid =
        isSecretKey(endpoint.previousSecret) &&
        endpoint.previousSecretExpiresAt !== null &&
        endpoint.previousSecretExpiresAt > this.now();
      return {
        publicKey: await publicKeyFor(endpoint.secret),
        previousPublicKey:
          previousValid && endpoint.previousSecret
            ? await publicKeyFor(endpoint.previousSecret)
            : null,
      };
    },

    /**
     * Replaces the signing secret. The old one keeps signing alongside the new one for
     * `graceSeconds` (default from the options), so receivers can switch without downtime. The
     * new secret has the same scheme as the old one unless you pass `secret`.
     */
    rotateSecret: async (
      id: string,
      options: TenantScope & { secret?: string; graceSeconds?: number } = {},
    ): Promise<Endpoint | undefined> => {
      const endpoint = await this.endpoints.get(id, options);
      if (!endpoint) return undefined;
      const now = this.now();
      const grace = options.graceSeconds ?? this.options.secretRotationGraceSeconds;
      return this.store.updateEndpoint(id, {
        secret: options.secret
          ? validateSecret(options.secret)
          : await newSecret(isSecretKey(endpoint.secret) ? "ed25519" : "hmac"),
        previousSecret: grace > 0 ? endpoint.secret : null,
        previousSecretExpiresAt: grace > 0 ? new Date(now.getTime() + grace * 1000) : null,
        updatedAt: now,
      });
    },
  };

  // ---------------------------------------------------------------- sending

  /**
   * Stores a message and queues one delivery per matching endpoint of the tenant. Delivery
   * happens in `process()` or the worker from `start()`, or right away with `deliverNow`.
   */
  async send(input: SendInput): Promise<SendResult> {
    assertEventType(input.eventType);
    const tenant = input.tenant ?? null;
    const json = JSON.stringify(input.payload);
    if (json === undefined) throw new TypeError("The payload must be JSON-serialisable.");
    if (new TextEncoder().encode(json).length > this.options.maxPayloadBytes) {
      throw new RangeError(`The payload is larger than ${this.options.maxPayloadBytes} bytes.`);
    }
    if (input.idempotencyKey) {
      const existing = await this.store.findMessageByIdempotencyKey(tenant, input.idempotencyKey);
      if (existing) {
        const deliveries = await this.store.listDeliveries({ messageId: existing.id, limit: 1000 });
        return { message: existing, deliveries, duplicate: true };
      }
    }
    const now = this.now();
    const message: Message = {
      id: createId("msg", now.getTime()),
      tenant,
      eventType: input.eventType,
      payload: JSON.parse(json),
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
    };
    const only = input.endpointIds ? new Set(input.endpointIds) : undefined;
    const endpoints = (await this.store.endpointsForTenant(tenant)).filter(
      (endpoint) =>
        endpoint.enabled &&
        endpointWants(endpoint.eventTypes, message.eventType) &&
        (!only || only.has(endpoint.id)),
    );
    // With deliverNow the deliveries are stored locked, so no worker picks them up meanwhile.
    const deliveries = endpoints.map((endpoint) => {
      const delivery = this.newDelivery(message, endpoint.id, now);
      return input.deliverNow ? this.lockLocal(delivery) : delivery;
    });
    try {
      await this.store.insertMessage(message);
    } catch (error) {
      // Two sends with the same key at once: the store's unique index lets only one win.
      const winner = input.idempotencyKey
        ? await this.store.findMessageByIdempotencyKey(tenant, input.idempotencyKey)
        : undefined;
      if (!winner) throw error;
      const existing = await this.store.listDeliveries({ messageId: winner.id, limit: 1000 });
      return { message: winner, deliveries: existing, duplicate: true };
    }
    if (deliveries.length) await this.store.insertDeliveries(deliveries);
    if (input.deliverNow && deliveries.length) {
      await this.deliverClaimed(deliveries);
      const fresh = await Promise.all(deliveries.map((d) => this.store.getDelivery(d.id)));
      return { message, deliveries: fresh.filter((d): d is Delivery => !!d), duplicate: false };
    }
    return { message, deliveries, duplicate: false };
  }

  private newDelivery(message: Message, endpointId: string, now: Date): Delivery {
    return {
      id: createId("del", now.getTime()),
      messageId: message.id,
      endpointId,
      tenant: message.tenant,
      eventType: message.eventType,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lockedUntil: null,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private lockLocal(delivery: Delivery): Delivery {
    return { ...delivery, lockedUntil: this.lockUntil() };
  }

  private lockUntil(): Date {
    return new Date(this.now().getTime() + this.options.timeoutMs + 60_000);
  }

  /**
   * Sends a `webhook.test` event to one endpoint right away, ignoring its event type filter, and
   * returns the delivery after the attempt. For "Send test event" buttons.
   */
  async sendTest(
    endpointId: string,
    options: TenantScope & { payload?: unknown } = {},
  ): Promise<Delivery | undefined> {
    const endpoint = await this.endpoints.get(endpointId, options);
    if (!endpoint) return undefined;
    const now = this.now();
    const message: Message = {
      id: createId("msg", now.getTime()),
      tenant: endpoint.tenant,
      eventType: "webhook.test",
      payload: options.payload ?? { message: "This is a test event from Vector." },
      idempotencyKey: null,
      createdAt: now,
    };
    const delivery = this.lockLocal(this.newDelivery(message, endpoint.id, now));
    await this.store.insertMessage(message);
    await this.store.insertDeliveries([delivery]);
    await this.deliverClaimed([delivery], { ignoreDisabled: true });
    return this.store.getDelivery(delivery.id);
  }

  // ---------------------------------------------------------------- delivering

  /** Delivers everything that is due once. Call it from a cron job or a queue consumer. */
  async process(options: ProcessOptions = {}): Promise<ProcessResult> {
    const limit = options.limit ?? 50;
    const claimed = await this.store.claimDueDeliveries(this.now(), limit, this.lockUntil());
    return this.deliverClaimed(claimed, { concurrency: options.concurrency });
  }

  /** Runs `process()` in a loop until `stop()` is called. For long-running servers. */
  start(options: WorkerOptions = {}): Worker {
    const limit = options.limit ?? 50;
    const interval = options.intervalMs ?? 1000;
    let stopped = false;
    let wake: (() => void) | undefined;
    const loop = (async () => {
      while (!stopped) {
        let claimed = 0;
        try {
          claimed = (await this.process({ ...options, limit })).claimed;
        } catch (error) {
          this.onError(error);
        }
        if (stopped) break;
        if (claimed < limit) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, interval);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
        }
      }
    })();
    return {
      stop: async () => {
        stopped = true;
        wake?.();
        await loop;
      },
    };
  }

  private async deliverClaimed(
    deliveries: Delivery[],
    options: { concurrency?: number | undefined; ignoreDisabled?: boolean } = {},
  ): Promise<ProcessResult> {
    const result: ProcessResult = {
      claimed: deliveries.length,
      succeeded: 0,
      retrying: 0,
      failed: 0,
      cancelled: 0,
    };
    const queue = [...deliveries];
    const workers = Array.from({ length: Math.max(1, options.concurrency ?? 10) }, async () => {
      for (let delivery = queue.shift(); delivery; delivery = queue.shift()) {
        try {
          result[await this.attempt(delivery, options.ignoreDisabled ?? false)]++;
        } catch (error) {
          this.onError(error);
        }
      }
    });
    await Promise.all(workers);
    return result;
  }

  private async attempt(delivery: Delivery, ignoreDisabled: boolean): Promise<Outcome> {
    const [endpoint, message] = await Promise.all([
      this.store.getEndpoint(delivery.endpointId),
      this.store.getMessage(delivery.messageId),
    ]);
    if (!endpoint || !message || (!endpoint.enabled && !ignoreDisabled)) {
      await this.store.updateDelivery(delivery.id, {
        status: "cancelled",
        nextAttemptAt: null,
        lockedUntil: null,
        lastError: !endpoint || !message ? "Endpoint deleted" : "Endpoint disabled",
        updatedAt: this.now(),
      });
      return "cancelled";
    }

    const at = this.now();
    const body = this.options.envelope
      ? JSON.stringify({
          type: message.eventType,
          timestamp: message.createdAt.toISOString(),
          data: message.payload,
        })
      : JSON.stringify(message.payload);
    const previous =
      endpoint.previousSecret &&
      endpoint.previousSecretExpiresAt &&
      endpoint.previousSecretExpiresAt > at
        ? [endpoint.previousSecret]
        : [];
    const signed = await signHeaders({
      id: message.id,
      timestamp: at,
      payload: body,
      secret: endpoint.secret,
      secrets: previous,
    });

    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;
    let retryAfter: number | undefined;
    const started = Date.now();
    try {
      await assertDeliverableUrl(endpoint.url, this.options.urlPolicy);
      const response = await this.fetchImpl(endpoint.url, {
        method: "POST",
        headers: {
          ...endpoint.headers,
          "content-type": "application/json",
          "user-agent": this.options.userAgent,
          ...signed,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      statusCode = response.status;
      retryAfter = retryAfterSeconds(response);
      responseBody = await readLimited(response, this.options.maxResponseBytes).catch(() => null);
      if (statusCode >= 300 && statusCode < 400) error = "Redirects are not followed";
      else if (statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode}`;
    } catch (caught) {
      error = errorText(caught);
    }
    const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

    const attempt: Attempt = {
      id: createId("att", at.getTime()),
      deliveryId: delivery.id,
      messageId: message.id,
      endpointId: endpoint.id,
      tenant: delivery.tenant,
      at,
      durationMs: Date.now() - started,
      statusCode,
      success,
      error,
      responseBody,
    };
    await this.store.insertAttempt(attempt);

    const attempts = delivery.attempts + 1;
    const base: Partial<Delivery> = {
      attempts,
      lastAttemptAt: at,
      lastStatusCode: statusCode,
      lastError: error,
      lockedUntil: null,
      updatedAt: this.now(),
    };

    let outcome: Outcome;
    let updated: Delivery | undefined;
    let current = endpoint;
    if (success) {
      updated = await this.store.updateDelivery(delivery.id, {
        ...base,
        status: "succeeded",
        nextAttemptAt: null,
      });
      if (endpoint.failureStreak > 0) {
        current = (await this.store.updateEndpoint(endpoint.id, { failureStreak: 0 })) ?? endpoint;
      }
      outcome = "succeeded";
    } else if (statusCode === 410 && this.options.disableOnGone) {
      updated = await this.store.updateDelivery(delivery.id, {
        ...base,
        status: "failed",
        nextAttemptAt: null,
      });
      current = await this.disable(endpoint, "The endpoint answered 410 Gone");
      outcome = "failed";
    } else if (attempts > this.options.retrySchedule.length) {
      updated = await this.store.updateDelivery(delivery.id, {
        ...base,
        status: "failed",
        nextAttemptAt: null,
      });
      const fresh = (await this.store.getEndpoint(endpoint.id)) ?? endpoint;
      const streak = fresh.failureStreak + 1;
      current = (await this.store.updateEndpoint(endpoint.id, { failureStreak: streak })) ?? fresh;
      const limit = this.options.disableEndpointAfter;
      if (limit > 0 && streak >= limit && current.enabled) {
        current = await this.disable(current, `${streak} deliveries in a row failed`);
      }
      outcome = "failed";
    } else {
      const scheduled = this.options.retrySchedule[attempts - 1] ?? 0;
      const jitter = 0.9 + this.options.random() * 0.2;
      const wait = Math.min(Math.max(scheduled * jitter, retryAfter ?? 0), 86_400);
      updated = await this.store.updateDelivery(delivery.id, {
        ...base,
        status: "pending",
        nextAttemptAt: new Date(at.getTime() + wait * 1000),
      });
      outcome = "retrying";
    }

    const final = updated ?? { ...delivery, ...base };
    await this.emit("attempt", { attempt, delivery: final, endpoint: current, message });
    if (outcome === "succeeded") {
      await this.emit("delivery.succeeded", { delivery: final, endpoint: current, message });
    } else if (outcome === "failed") {
      await this.emit("delivery.failed", { delivery: final, endpoint: current, message });
    }
    return outcome;
  }

  private async disable(endpoint: Endpoint, reason: string): Promise<Endpoint> {
    const updated =
      (await this.store.updateEndpoint(endpoint.id, {
        enabled: false,
        disabledReason: reason,
        updatedAt: this.now(),
      })) ?? endpoint;
    await this.emit("endpoint.disabled", { endpoint: updated, reason });
    return updated;
  }

  // ---------------------------------------------------------------- recovery

  /** Queues a delivery again with a fresh set of attempts, starting now. */
  async retry(deliveryId: string, scope?: TenantScope): Promise<Delivery | undefined> {
    const delivery = await this.store.getDelivery(deliveryId);
    if (!delivery || !inTenant(delivery, scope)) return undefined;
    const now = this.now();
    return this.store.updateDelivery(deliveryId, {
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lockedUntil: null,
      updatedAt: now,
    });
  }

  /**
   * Sends a stored message again: to all endpoints it went to, or to one endpoint (which may be
   * new since the message was sent).
   */
  async resend(
    messageId: string,
    options: TenantScope & { endpointId?: string } = {},
  ): Promise<Delivery[]> {
    const message = await this.store.getMessage(messageId);
    if (!message || !inTenant(message, options)) return [];
    const existing = await this.store.listDeliveries({ messageId, limit: 1000 });
    const targets = options.endpointId
      ? existing.filter((d) => d.endpointId === options.endpointId)
      : existing;
    const out: Delivery[] = [];
    for (const delivery of targets) {
      const retried = await this.retry(delivery.id);
      if (retried) out.push(retried);
    }
    if (options.endpointId && targets.length === 0) {
      const endpoint = await this.store.getEndpoint(options.endpointId);
      if (endpoint && endpoint.tenant === message.tenant) {
        const delivery = this.newDelivery(message, endpoint.id, this.now());
        await this.store.insertDeliveries([delivery]);
        out.push(delivery);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- reading

  readonly messages = {
    get: async (id: string, scope?: TenantScope): Promise<Message | undefined> => {
      const message = await this.store.getMessage(id);
      return inTenant(message, scope) ? message : undefined;
    },
    list: (query: MessageQuery = {}): Promise<Message[]> => this.store.listMessages(query),
  };

  readonly deliveries = {
    get: async (id: string, scope?: TenantScope): Promise<Delivery | undefined> => {
      const delivery = await this.store.getDelivery(id);
      return inTenant(delivery, scope) ? delivery : undefined;
    },
    list: (query: DeliveryQuery = {}): Promise<Delivery[]> => this.store.listDeliveries(query),
  };

  readonly attempts = {
    list: (query: AttemptQuery = {}): Promise<Attempt[]> => this.store.listAttempts(query),
  };
}

/** Creates a webhook sender. See `VectorOptions`. */
export function createVector(options?: VectorOptions): Vector {
  return new Vector(options);
}

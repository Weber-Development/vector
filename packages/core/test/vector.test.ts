import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_SCHEDULE, MemoryStore, UrlNotAllowedError } from "../src/index";
import { fakeNetwork, testVector, verifyReceived } from "./helpers";

const URL_A = "https://a.example.com/hook";
const URL_B = "https://b.example.com/hook";

describe("endpoints", () => {
  it("creates endpoints with a secret and validates input", async () => {
    const { vector } = testVector({});
    const endpoint = await vector.endpoints.create({
      url: URL_A,
      tenant: "acme",
      eventTypes: ["invoice.*"],
      headers: { "X-Api-Key": "k" },
    });
    expect(endpoint.id).toMatch(/^ep_/);
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect(endpoint.headers).toEqual({ "x-api-key": "k" });
    expect(await vector.endpoints.get(endpoint.id, { tenant: "other" })).toBeUndefined();
    expect(await vector.endpoints.get(endpoint.id, { tenant: "acme" })).toBeTruthy();

    await expect(vector.endpoints.create({ url: "https://127.0.0.1/" })).rejects.toBeInstanceOf(
      UrlNotAllowedError,
    );
    await expect(
      vector.endpoints.create({ url: URL_A, headers: { "webhook-signature": "x" } }),
    ).rejects.toThrow("cannot be overridden");
    await expect(
      vector.endpoints.create({ url: URL_A, headers: { "x-a": "b\r\nInjected: 1" } }),
    ).rejects.toThrow("Invalid value");
    await expect(vector.endpoints.create({ url: URL_A, eventTypes: ["bad type"] })).rejects.toThrow(
      "Invalid event type",
    );
    await expect(vector.endpoints.create({ url: URL_A, secret: "whsec_c2hvcnQ=" })).rejects.toThrow(
      "at least 24 bytes",
    );
  });

  it("updates, disables, re-enables and deletes", async () => {
    const { vector } = testVector({});
    const endpoint = await vector.endpoints.create({ url: URL_A });
    const disabled = await vector.endpoints.update(endpoint.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.disabledReason).toBe("Disabled manually");
    const enabled = await vector.endpoints.update(endpoint.id, { enabled: true, url: URL_B });
    expect(enabled).toMatchObject({ enabled: true, disabledReason: null, url: URL_B });
    expect(await vector.endpoints.update("ep_missing", { enabled: true })).toBeUndefined();
    expect(await vector.endpoints.delete(endpoint.id, { tenant: "x" })).toBe(false);
    expect(await vector.endpoints.delete(endpoint.id)).toBe(true);
    expect(await vector.endpoints.list()).toHaveLength(0);
  });
});

describe("sending", () => {
  it("fans out to matching endpoints of the tenant only", async () => {
    const { vector, network, time } = testVector({});
    const a = await vector.endpoints.create({ url: URL_A, tenant: "acme" });
    await vector.endpoints.create({ url: URL_B, tenant: "acme", eventTypes: ["user.*"] });
    await vector.endpoints.create({ url: "https://c.example.com/", tenant: "globex" });
    await vector.endpoints.create({
      url: "https://d.example.com/",
      tenant: "acme",
      enabled: false,
    });

    const { message, deliveries } = await vector.send({
      eventType: "invoice.paid",
      payload: { invoice: "inv_1", amount: 4200 },
      tenant: "acme",
    });
    expect(message.id).toMatch(/^msg_/);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.endpointId).toBe(a.id);

    const result = await vector.process();
    expect(result).toEqual({ claimed: 1, succeeded: 1, retrying: 0, failed: 0, cancelled: 0 });
    expect(network.received).toHaveLength(1);
    const request = network.received[0]!;
    expect(request.url).toBe(URL_A);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["webhook-id"]).toBe(message.id);
    const verified = await verifyReceived(request, a.secret, time.now());
    expect(verified.payload).toEqual({
      type: "invoice.paid",
      timestamp: "2026-10-05T12:00:00.000Z",
      data: { invoice: "inv_1", amount: 4200 },
    });

    const [delivery] = await vector.deliveries.list({ messageId: message.id });
    expect(delivery).toMatchObject({ status: "succeeded", attempts: 1, lastStatusCode: 200 });
    const attempts = await vector.attempts.list({ deliveryId: delivery?.id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      success: true,
      statusCode: 200,
      responseBody: "status 200",
    });
  });

  it("is idempotent per tenant and key", async () => {
    const { vector } = testVector({});
    await vector.endpoints.create({ url: URL_A });
    const first = await vector.send({ eventType: "a.b", payload: 1, idempotencyKey: "k1" });
    const second = await vector.send({ eventType: "a.b", payload: 2, idempotencyKey: "k1" });
    expect(second.duplicate).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(second.deliveries).toHaveLength(1);
    const other = await vector.send({
      eventType: "a.b",
      payload: 3,
      idempotencyKey: "k1",
      tenant: "t2",
    });
    expect(other.duplicate).toBe(false);
  });

  it("validates event type and payload", async () => {
    const { vector } = testVector({ maxPayloadBytes: 10 });
    await expect(vector.send({ eventType: "no spaces", payload: {} })).rejects.toThrow(
      "Invalid event type",
    );
    await expect(vector.send({ eventType: "a.b", payload: undefined })).rejects.toThrow(
      "JSON-serialisable",
    );
    await expect(vector.send({ eventType: "a.b", payload: "x".repeat(20) })).rejects.toThrow(
      RangeError,
    );
  });

  it("delivers right away with deliverNow and keeps workers away meanwhile", async () => {
    const network = fakeNetwork();
    const { vector } = testVector({ network });
    await vector.endpoints.create({ url: URL_A });
    const { deliveries } = await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    expect(deliveries[0]?.status).toBe("succeeded");
    expect(network.received).toHaveLength(1);
    expect((await vector.process()).claimed).toBe(0);
  });

  it("can send the bare payload without the envelope", async () => {
    const { vector, network } = testVector({ envelope: false });
    await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: { id: 1 }, deliverNow: true });
    expect(JSON.parse(network.received[0]?.body ?? "")).toEqual({ id: 1 });
  });

  it("sends custom headers but never lets them replace the signature", async () => {
    const { vector, network } = testVector({});
    await vector.endpoints.create({ url: URL_A, headers: { authorization: "Bearer t" } });
    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    expect(network.received[0]?.headers.authorization).toBe("Bearer t");
    expect(network.received[0]?.headers["user-agent"]).toBe("Vector-Webhooks/1");
  });
});

describe("retries", () => {
  it("retries on the schedule with jitter and gives up after the last attempt", async () => {
    const network = fakeNetwork({ [URL_A]: [500] });
    const { vector, time } = testVector({ network, disableEndpointAfter: 0 });
    const failed = vi.fn();
    vector.on("delivery.failed", failed);
    await vector.endpoints.create({ url: URL_A });
    const { deliveries } = await vector.send({ eventType: "a.b", payload: {} });
    const id = deliveries[0]!.id;

    expect((await vector.process()).retrying).toBe(1);
    for (const [index, seconds] of DEFAULT_RETRY_SCHEDULE.entries()) {
      const pending = await vector.deliveries.get(id);
      expect(pending?.status).toBe("pending");
      // random() is 0.5, so the jitter factor is exactly 1.
      expect(pending?.nextAttemptAt?.getTime()).toBe(time.now().getTime() + seconds * 1000);
      time.advance(seconds - 1);
      expect((await vector.process()).claimed).toBe(0);
      time.advance(1);
      const result = await vector.process();
      expect(result.claimed).toBe(1);
      expect(index === DEFAULT_RETRY_SCHEDULE.length - 1 ? result.failed : result.retrying).toBe(1);
    }
    const final = await vector.deliveries.get(id);
    expect(final).toMatchObject({ status: "failed", attempts: 8, lastStatusCode: 500 });
    expect(network.received).toHaveLength(8);
    // The same message id on every attempt, so receivers can deduplicate.
    expect(new Set(network.received.map((r) => r.headers["webhook-id"])).size).toBe(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("recovers after a failure and resets the failure streak", async () => {
    const network = fakeNetwork({ [URL_A]: [503, new Error("socket hang up"), 200] });
    const { vector, time } = testVector({ network, retrySchedule: [1, 1] });
    await vector.endpoints.create({ url: URL_A });
    const { deliveries } = await vector.send({ eventType: "a.b", payload: {} });
    await vector.process();
    time.advance(1);
    await vector.process();
    time.advance(1);
    await vector.process();
    const delivery = await vector.deliveries.get(deliveries[0]!.id);
    expect(delivery).toMatchObject({ status: "succeeded", attempts: 3 });
    const attempts = await vector.attempts.list({ deliveryId: delivery?.id });
    expect(attempts.map((a) => a.error)).toEqual([null, "socket hang up", "HTTP 503"]);
  });

  it("honours Retry-After and does not follow redirects", async () => {
    const network = fakeNetwork({
      [URL_A]: [
        new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
      ],
    });
    const { vector, time } = testVector({ network, retrySchedule: [5, 5] });
    await vector.endpoints.create({ url: URL_A });
    const { deliveries } = await vector.send({ eventType: "a.b", payload: {} });
    await vector.process();
    const afterRateLimit = await vector.deliveries.get(deliveries[0]!.id);
    expect(afterRateLimit?.nextAttemptAt?.getTime()).toBe(time.now().getTime() + 120_000);
    time.advance(120);
    await vector.process();
    const afterRedirect = await vector.deliveries.get(deliveries[0]!.id);
    expect(afterRedirect).toMatchObject({ status: "pending", lastStatusCode: 302 });
    expect(afterRedirect?.lastError).toBe("Redirects are not followed");
    expect(network.received).toHaveLength(2);
  });

  it("disables an endpoint after too many failed deliveries in a row", async () => {
    const network = fakeNetwork({ [URL_A]: [500] });
    const { vector } = testVector({ network, retrySchedule: [], disableEndpointAfter: 2 });
    const disabled = vi.fn();
    vector.on("endpoint.disabled", disabled);
    const endpoint = await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: 1 });
    await vector.process();
    expect((await vector.endpoints.get(endpoint.id))?.failureStreak).toBe(1);
    await vector.send({ eventType: "a.b", payload: 2 });
    await vector.send({ eventType: "a.b", payload: 3 });
    await vector.process({ concurrency: 1 });
    const after = await vector.endpoints.get(endpoint.id);
    expect(after).toMatchObject({ enabled: false, failureStreak: 2 });
    expect(after?.disabledReason).toContain("2 deliveries in a row failed");
    expect(disabled).toHaveBeenCalledTimes(1);
    // The third delivery was cancelled because the endpoint was off by then.
    const statuses = (await vector.deliveries.list()).map((d) => d.status).sort();
    expect(statuses).toEqual(["cancelled", "failed", "failed"]);
    // Disabled endpoints get no new deliveries.
    expect((await vector.send({ eventType: "a.b", payload: 4 })).deliveries).toHaveLength(0);
  });

  it("disables an endpoint that answers 410 Gone", async () => {
    const network = fakeNetwork({ [URL_A]: [410] });
    const { vector } = testVector({ network });
    const endpoint = await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    expect(await vector.endpoints.get(endpoint.id)).toMatchObject({ enabled: false });
  });

  it("re-checks the URL before every attempt", async () => {
    let address = "93.184.215.14";
    const { vector, network } = testVector({
      urlPolicy: { resolveHost: async () => [address] },
      retrySchedule: [0],
    });
    await vector.endpoints.create({ url: URL_A });
    address = "10.0.0.1";
    await vector.send({ eventType: "a.b", payload: {} });
    await vector.process();
    expect(network.received).toHaveLength(0);
    const [attempt] = await vector.attempts.list();
    expect(attempt?.error).toContain("private address 10.0.0.1");
  });

  it("stores only the start of large responses", async () => {
    const network = fakeNetwork({ [URL_A]: [new Response("x".repeat(10_000), { status: 500 })] });
    const { vector } = testVector({ network, maxResponseBytes: 100 });
    await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    const [attempt] = await vector.attempts.list();
    expect(attempt?.responseBody).toHaveLength(100);
  });

  it("times out slow endpoints", async () => {
    const slow = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const { vector } = testVector({ network: { fetch: slow, received: [] }, timeoutMs: 50 });
    await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    const [attempt] = await vector.attempts.list();
    expect(attempt?.error).toBe("Timed out");
  });
});

describe("rotation, recovery and workers", () => {
  it("signs with old and new secret during the grace period", async () => {
    const { vector, network, time } = testVector({});
    const endpoint = await vector.endpoints.create({ url: URL_A });
    const rotated = await vector.endpoints.rotateSecret(endpoint.id, { graceSeconds: 60 });
    expect(rotated?.secret).not.toBe(endpoint.secret);
    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    await expect(
      verifyReceived(network.received[0]!, endpoint.secret, time.now()),
    ).resolves.toBeTruthy();
    await expect(
      verifyReceived(network.received[0]!, rotated!.secret, time.now()),
    ).resolves.toBeTruthy();
    time.advance(61);
    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    await expect(
      verifyReceived(network.received[1]!, endpoint.secret, time.now()),
    ).rejects.toThrow();
    await expect(
      verifyReceived(network.received[1]!, rotated!.secret, time.now()),
    ).resolves.toBeTruthy();
  });

  it("retries a failed delivery and resends a message to a new endpoint", async () => {
    const network = fakeNetwork({ [URL_A]: [500, 200] });
    const { vector } = testVector({ network, retrySchedule: [] });
    await vector.endpoints.create({ url: URL_A });
    const { message, deliveries } = await vector.send({ eventType: "a.b", payload: {} });
    await vector.process();
    expect((await vector.deliveries.get(deliveries[0]!.id))?.status).toBe("failed");
    expect(await vector.retry(deliveries[0]!.id, { tenant: "other" })).toBeUndefined();
    await vector.retry(deliveries[0]!.id);
    await vector.process();
    expect((await vector.deliveries.get(deliveries[0]!.id))?.status).toBe("succeeded");

    const b = await vector.endpoints.create({ url: URL_B });
    const resent = await vector.resend(message.id, { endpointId: b.id });
    expect(resent).toHaveLength(1);
    await vector.process();
    expect(network.received.map((r) => r.url)).toEqual([URL_A, URL_A, URL_B]);
  });

  it("cancels deliveries for deleted endpoints", async () => {
    const { vector } = testVector({});
    const endpoint = await vector.endpoints.create({ url: URL_A });
    const { deliveries } = await vector.send({ eventType: "a.b", payload: {} });
    await vector.endpoints.delete(endpoint.id);
    expect((await vector.process()).cancelled).toBe(1);
    expect((await vector.deliveries.get(deliveries[0]!.id))?.lastError).toBe("Endpoint deleted");
  });

  it("sends test events even to filtered endpoints", async () => {
    const { vector, network } = testVector({});
    const endpoint = await vector.endpoints.create({ url: URL_A, eventTypes: ["invoice.paid"] });
    const delivery = await vector.sendTest(endpoint.id);
    expect(delivery?.status).toBe("succeeded");
    expect(JSON.parse(network.received[0]!.body).type).toBe("webhook.test");
  });

  it("never lets two workers claim the same delivery", async () => {
    const store = new MemoryStore();
    const network = fakeNetwork();
    const one = testVector({ store, network });
    const two = testVector({ store, network });
    await one.vector.endpoints.create({ url: URL_A });
    for (let i = 0; i < 20; i++) await one.vector.send({ eventType: "a.b", payload: i });
    const [r1, r2] = await Promise.all([
      one.vector.process({ limit: 15 }),
      two.vector.process({ limit: 15 }),
    ]);
    expect(r1.claimed + r2.claimed).toBe(20);
    expect(network.received).toHaveLength(20);
  });

  it("runs a background worker until stopped", async () => {
    const { vector, network } = testVector({});
    await vector.endpoints.create({ url: URL_A });
    const worker = vector.start({ intervalMs: 5 });
    await vector.send({ eventType: "a.b", payload: {} });
    await vi.waitFor(() => expect(network.received).toHaveLength(1));
    await worker.stop();
  });

  it("reports listener errors without breaking delivery", async () => {
    const onError = vi.fn();
    const { vector } = testVector({ onError });
    vector.on("attempt", () => {
      throw new Error("listener broke");
    });
    await vector.endpoints.create({ url: URL_A });
    const { deliveries } = await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    expect(deliveries[0]?.status).toBe("succeeded");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "listener broke" }));
  });
});

describe("sendMany", () => {
  it("sends a batch with one endpoint lookup per tenant and keeps the order", async () => {
    const network = fakeNetwork();
    const { vector } = testVector({ network });
    await vector.endpoints.create({ url: "https://a.example.com/hook", tenant: "acme" });
    await vector.endpoints.create({ url: "https://b.example.com/hook", tenant: "other" });
    const calls: unknown[] = [];
    const original = vector.store.endpointsForTenant.bind(vector.store);
    vector.store.endpointsForTenant = (tenant) => {
      calls.push(tenant);
      return original(tenant);
    };
    const results = await vector.sendMany([
      { eventType: "a.b", payload: { n: 1 }, tenant: "acme" },
      { eventType: "a.b", payload: { n: 2 }, tenant: "other" },
      { eventType: "a.b", payload: { n: 3 }, tenant: "acme", idempotencyKey: "k" },
      { eventType: "a.b", payload: { n: 4 }, tenant: "acme", idempotencyKey: "k" },
    ]);
    expect(results.map((r) => (r.message.payload as { n: number }).n)).toEqual([1, 2, 3, 3]);
    expect(results.map((r) => r.deliveries.length)).toEqual([1, 1, 1, 1]);
    expect(results[3]?.duplicate).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect((await vector.process()).succeeded).toBe(3);
  });

  it("stores nothing when one input is invalid", async () => {
    const { vector } = testVector({});
    await vector.endpoints.create({ url: "https://a.example.com/hook" });
    await expect(
      vector.sendMany([
        { eventType: "a.b", payload: {} },
        { eventType: "not valid!", payload: {} },
      ]),
    ).rejects.toThrow();
    expect(await vector.store.listMessages({})).toHaveLength(0);
    await expect(
      vector.sendMany(Array.from({ length: 1001 }, () => ({ eventType: "a.b", payload: {} }))),
    ).rejects.toThrow(RangeError);
  });
});

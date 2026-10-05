import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createPostgresStore, type PostgresStore, postgresSchema } from "../src/postgres";
import { fakeNetwork, testVector } from "./helpers";

const URL_A = "https://a.example.com/hook";

describe("postgres store", () => {
  let db: PGlite;
  let store: PostgresStore;

  beforeEach(async () => {
    db = new PGlite();
    store = createPostgresStore({
      query: (text, params) =>
        db.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
    });
    await store.migrate();
    await store.migrate(); // idempotent
  });

  it("runs the full send, retry and log cycle", async () => {
    const network = fakeNetwork({ [URL_A]: [500, 200] });
    const { vector, time } = testVector({ store, network, retrySchedule: [10] });
    const endpoint = await vector.endpoints.create({
      url: URL_A,
      tenant: "acme",
      eventTypes: ["invoice.*"],
      metadata: { plan: "pro" },
    });
    expect(await vector.endpoints.get(endpoint.id)).toEqual(endpoint);

    const { message } = await vector.send({
      eventType: "invoice.paid",
      payload: { amount: 1, nested: { ok: true } },
      tenant: "acme",
      idempotencyKey: "pay_1",
    });
    expect(
      (
        await vector.send({
          eventType: "invoice.paid",
          payload: {},
          tenant: "acme",
          idempotencyKey: "pay_1",
        })
      ).duplicate,
    ).toBe(true);
    expect(await vector.messages.get(message.id)).toEqual(message);

    expect((await vector.process()).retrying).toBe(1);
    time.advance(10);
    expect((await vector.process()).succeeded).toBe(1);

    const [delivery] = await vector.deliveries.list({ tenant: "acme" });
    expect(delivery).toMatchObject({ status: "succeeded", attempts: 2, lastStatusCode: 200 });
    const attempts = await vector.attempts.list({ messageId: message.id });
    expect(attempts.map((a) => a.statusCode)).toEqual([200, 500]);
    expect(attempts[0]?.at).toBeInstanceOf(Date);
    expect(await vector.messages.list({ tenant: "acme", eventType: "invoice.paid" })).toHaveLength(
      1,
    );
    expect(await vector.messages.list({ tenant: null })).toHaveLength(0);
  });

  it("handles null tenants, updates and deletes", async () => {
    const { vector } = testVector({ store });
    const endpoint = await vector.endpoints.create({ url: URL_A });
    expect(await store.endpointsForTenant(null)).toHaveLength(1);
    expect(await store.endpointsForTenant("acme")).toHaveLength(0);
    const rotated = await vector.endpoints.rotateSecret(endpoint.id);
    expect(rotated?.previousSecret).toBe(endpoint.secret);
    expect(rotated?.previousSecretExpiresAt).toBeInstanceOf(Date);
    const updated = await vector.endpoints.update(endpoint.id, { eventTypes: null, headers: {} });
    expect(updated?.eventTypes).toBeNull();
    expect(await vector.endpoints.list({ tenant: null })).toHaveLength(1);
    expect(await vector.endpoints.delete(endpoint.id)).toBe(true);
    expect(await vector.endpoints.delete(endpoint.id)).toBe(false);
  });

  it("claims each due delivery once", async () => {
    const { vector } = testVector({ store });
    await vector.endpoints.create({ url: URL_A });
    for (let i = 0; i < 5; i++) await vector.send({ eventType: "a.b", payload: i });
    const now = new Date("2026-10-05T12:00:00Z");
    const lock = new Date(now.getTime() + 60_000);
    const first = await store.claimDueDeliveries(now, 3, lock);
    const second = await store.claimDueDeliveries(now, 3, lock);
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(2);
    expect(await store.claimDueDeliveries(now, 3, lock)).toHaveLength(0);
    expect(await store.claimDueDeliveries(lock, 10, new Date(lock.getTime() + 1))).toHaveLength(5);
  });

  it("supports a table prefix and rejects unsafe ones", async () => {
    expect(postgresSchema("hooks_")).toContain("create table if not exists hooks_endpoints");
    expect(() =>
      createPostgresStore({ query: async () => ({ rows: [] }), tablePrefix: "x; drop" }),
    ).toThrow();
  });
});

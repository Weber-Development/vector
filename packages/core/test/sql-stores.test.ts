import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMysqlStore, type MysqlQuery, mysql2Query, mysqlSchema } from "../src/mysql";
import { createSqliteStore, sqliteSchema } from "../src/sqlite";
import type { VectorStore } from "../src/types";
import { fakeNetwork, testVector } from "./helpers";

const URL_A = "https://a.example.com/hook";

type Store = VectorStore & { migrate(): Promise<void> };

/** The same behaviour checks for every SQL store. `fresh` returns an empty, migrated store. */
function storeSuite(fresh: () => Promise<Store>) {
  let store: Store;

  beforeEach(async () => {
    store = await fresh();
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

    const payload = { amount: 1, nested: { ok: true }, text: "Grüezi 👋" };
    const { message } = await vector.send({
      eventType: "invoice.paid",
      payload,
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
    // The same key in another tenant is a new message.
    expect(
      (
        await vector.send({
          eventType: "invoice.paid",
          payload: {},
          tenant: "other",
          idempotencyKey: "pay_1",
        })
      ).duplicate,
    ).toBe(false);
    expect(await vector.messages.get(message.id)).toEqual(message);
    expect(message.payload).toEqual(payload);

    expect((await vector.process()).retrying).toBe(1);
    time.advance(10);
    expect((await vector.process()).succeeded).toBe(1);

    const [delivery] = await vector.deliveries.list({ tenant: "acme" });
    expect(delivery).toMatchObject({ status: "succeeded", attempts: 2, lastStatusCode: 200 });
    expect(delivery?.lastAttemptAt).toBeInstanceOf(Date);
    const attempts = await vector.attempts.list({ messageId: message.id });
    expect(attempts.map((a) => a.statusCode)).toEqual([200, 500]);
    expect(attempts.map((a) => a.success)).toEqual([true, false]);
    expect(attempts[0]?.at).toBeInstanceOf(Date);
    expect(await vector.messages.list({ tenant: "acme", eventType: "invoice.paid" })).toHaveLength(
      1,
    );
    expect(await vector.messages.list({ tenant: null })).toHaveLength(0);
    expect(
      await vector.messages.list({ tenant: "acme", since: new Date("2030-01-01") }),
    ).toHaveLength(0);
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
    const disabled = await vector.endpoints.update(endpoint.id, { enabled: false });
    expect(disabled?.enabled).toBe(false);
    expect(await store.endpointsForTenant(null)).toHaveLength(0);
    expect(await vector.endpoints.list({ tenant: null })).toHaveLength(1);
    expect(await store.updateEndpoint("ep_missing", { url: URL_A })).toBeUndefined();
    expect(await vector.endpoints.delete(endpoint.id)).toBe(true);
    expect(await vector.endpoints.delete(endpoint.id)).toBe(false);
  });

  it("lets only one of two messages with the same idempotency key in", async () => {
    const { vector } = testVector({ store });
    await vector.endpoints.create({ url: URL_A });
    const results = await Promise.all([
      vector.send({ eventType: "a.b", payload: 1, idempotencyKey: "k" }),
      vector.send({ eventType: "a.b", payload: 2, idempotencyKey: "k" }),
    ]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect(results[0]?.message.id).toBe(results[1]?.message.id);
    expect(await vector.messages.list({})).toHaveLength(1);
  });

  it("claims each due delivery once", async () => {
    const { vector } = testVector({ store });
    await vector.endpoints.create({ url: URL_A });
    for (let i = 0; i < 5; i++) await vector.send({ eventType: "a.b", payload: i });
    const now = new Date("2026-10-05T12:00:00Z");
    const lock = new Date(now.getTime() + 60_000);
    const [first, second] = await Promise.all([
      store.claimDueDeliveries(now, 3, lock),
      store.claimDueDeliveries(now, 3, lock),
    ]);
    expect((first?.length ?? 0) + (second?.length ?? 0)).toBe(5);
    const ids = new Set([...(first ?? []), ...(second ?? [])].map((d) => d.id));
    expect(ids.size).toBe(5);
    expect(first?.[0]?.lockedUntil).toEqual(lock);
    expect(await store.claimDueDeliveries(now, 3, lock)).toHaveLength(0);
    expect(await store.claimDueDeliveries(lock, 10, new Date(lock.getTime() + 1))).toHaveLength(5);
  });
}

describe("sqlite store", () => {
  const dir = mkdtempSync(join(tmpdir(), "vector-sqlite-"));
  let n = 0;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  storeSuite(async () => createSqliteStore({ database: new DatabaseSync(":memory:") }));

  it("shares one database file between two stores", async () => {
    const file = join(dir, `shared-${n++}.db`);
    const a = createSqliteStore({ database: new DatabaseSync(file) });
    const b = createSqliteStore({ database: new DatabaseSync(file) });
    await a.migrate();
    const { vector } = testVector({ store: a });
    await vector.endpoints.create({ url: URL_A });
    for (let i = 0; i < 4; i++) await vector.send({ eventType: "a.b", payload: i });
    const now = new Date("2026-10-05T12:00:00Z");
    const lock = new Date(now.getTime() + 60_000);
    expect(await a.claimDueDeliveries(now, 3, lock)).toHaveLength(3);
    expect(await b.claimDueDeliveries(now, 3, lock)).toHaveLength(1);
  });

  it("supports a table prefix and rejects unsafe ones", async () => {
    expect(sqliteSchema("hooks_")).toContain("create table if not exists hooks_endpoints");
    const database = new DatabaseSync(":memory:");
    const store = createSqliteStore({ database, tablePrefix: "hooks_" });
    await store.migrate();
    expect(
      database.prepare("select name from sqlite_master where name = 'hooks_attempts'").all(),
    ).toHaveLength(1);
    expect(() => createSqliteStore({ database, tablePrefix: "x; drop" })).toThrow(TypeError);
  });
});

describe("mysql store", () => {
  it("supports a table prefix and rejects unsafe ones", () => {
    expect(mysqlSchema("hooks_")).toContain("create table if not exists hooks_endpoints");
    expect(() =>
      createMysqlStore({ query: async () => ({ rows: [], affectedRows: 0 }), tablePrefix: "x;" }),
    ).toThrow(TypeError);
  });

  it("adapts mysql2 results", async () => {
    const query = mysql2Query({
      query: async (sql) =>
        sql.startsWith("select") ? [[{ id: "a" }], []] : [{ affectedRows: 2 }, undefined],
    });
    expect(await query("select 1", [])).toEqual({ rows: [{ id: "a" }], affectedRows: 0 });
    expect(await query("update x", [])).toEqual({ rows: [], affectedRows: 2 });
  });

  // Runs against a real server when VECTOR_MYSQL_URL is set, as in CI.
  const url = process.env.VECTOR_MYSQL_URL;
  describe.runIf(Boolean(url))("against MySQL", () => {
    let pool: { query: MysqlQuery; end(): Promise<void> } | undefined;
    let n = 0;

    afterAll(async () => pool?.end());

    storeSuite(async () => {
      if (!pool) {
        const mysql = await import("mysql2/promise");
        const raw = mysql.createPool({ uri: url as string, connectionLimit: 4 });
        pool = { query: mysql2Query(raw as never), end: () => raw.end() };
      }
      const store = createMysqlStore({ query: pool.query, tablePrefix: `t${Date.now()}_${n++}_` });
      await store.migrate();
      return store;
    });
  });
});

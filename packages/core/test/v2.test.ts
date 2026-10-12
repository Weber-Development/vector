import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { MemoryStore, matchesFilter, SCHEMA_VERSION, validateFilter } from "../src/index";
import { createPostgresStore } from "../src/postgres";
import { createSqliteStore } from "../src/sqlite";
import type { VectorStore } from "../src/types";
import { fakeNetwork, testVector } from "./helpers";

const URL_A = "https://a.example.com/hook";

describe("payload filter", () => {
  it("matches operators and combinations", () => {
    const payload = { plan: "pro", amount: 120, tags: ["a", "b"], user: { country: "CH" } };
    const f = (x: unknown) => matchesFilter(validateFilter(x), payload);
    expect(f({ path: "plan", op: "eq", value: "pro" })).toBe(true);
    expect(f({ path: "user.country", op: "in", value: ["CH", "DE"] })).toBe(true);
    expect(f({ path: "amount", op: "gte", value: 200 })).toBe(false);
    expect(f({ path: "plan", op: "prefix", value: "pr" })).toBe(true);
    expect(f({ path: "tags", op: "contains", value: "b" })).toBe(true);
    expect(f({ path: "missing", op: "exists", value: false })).toBe(true);
    expect(f({ path: "missing", op: "eq", value: 1 })).toBe(false);
    expect(f({ path: "missing", op: "ne", value: 1 })).toBe(true);
    expect(
      f({
        and: [
          { path: "plan", op: "eq", value: "pro" },
          { not: { path: "user.country", op: "eq", value: "US" } },
        ],
      }),
    ).toBe(true);
    expect(
      f({
        or: [
          { path: "plan", op: "eq", value: "x" },
          { path: "amount", op: "lt", value: 5 },
        ],
      }),
    ).toBe(false);
    expect(matchesFilter(null, payload)).toBe(true);
  });

  it("rejects invalid filters", () => {
    expect(() => validateFilter({ path: "a", op: "nope", value: 1 })).toThrow();
    expect(() => validateFilter({ and: [] as unknown[] })).toThrow();
    let deep: unknown = { path: "a", op: "eq", value: 1 };
    for (let i = 0; i < 8; i++) deep = { not: deep };
    expect(() => validateFilter(deep)).toThrow();
  });

  it("only delivers to endpoints whose filter matches", async () => {
    const network = fakeNetwork();
    const { vector } = testVector({ network });
    const pro = await vector.endpoints.create({
      url: URL_A,
      filter: { path: "plan", op: "eq", value: "pro" },
    });
    await vector.endpoints.create({ url: "https://b.example.com/hook" });
    const a = await vector.send({ eventType: "x.y", payload: { plan: "pro" } });
    const b = await vector.send({ eventType: "x.y", payload: { plan: "free" } });
    expect(a.deliveries).toHaveLength(2);
    expect(b.deliveries).toHaveLength(1);
    expect(b.deliveries.some((d) => d.endpointId === pro.id)).toBe(false);
    await expect(
      vector.endpoints.create({ url: URL_A, filter: { path: "a", op: "zz", value: 1 } as never }),
    ).rejects.toThrow();
  });
});

function suite(name: string, fresh: () => Promise<VectorStore>) {
  describe(`${name}: ordering, replay, prune`, () => {
    it("delivers ordered messages one after another per key", async () => {
      const store = await fresh();
      const seen: number[] = [];
      let failedOnce = false;
      const fetch = (async (_url: unknown, init?: RequestInit) => {
        const n = JSON.parse(String(init?.body)).data.n as number;
        seen.push(n);
        if (n === 1 && !failedOnce) {
          failedOnce = true;
          return new Response("no", { status: 500 });
        }
        return new Response(null, { status: 204 });
      }) as typeof globalThis.fetch;
      const { vector, time } = testVector({ store, fetch, retrySchedule: [10] });
      await vector.endpoints.create({ url: URL_A });
      await vector.send({ eventType: "a.b", payload: { n: 1 }, orderingKey: "k1" });
      await vector.send({ eventType: "a.b", payload: { n: 2 }, orderingKey: "k1" });
      await vector.send({ eventType: "a.b", payload: { n: 3 }, orderingKey: "k2" });
      const first = await vector.process();
      // n=1 fails and n=2 must wait for it; n=3 (other key) goes out.
      expect(first.retrying).toBe(1);
      expect([...seen].sort()).toEqual([1, 3]);
      time.advance(10);
      await vector.process();
      await vector.process();
      expect(seen.slice(2)).toEqual([1, 2]);
    });

    it("replays a range oldest first and honours filters", async () => {
      const store = await fresh();
      const { vector, time } = testVector({ store });
      const from = time.now();
      await vector.send({ eventType: "a.b", payload: { n: 1 }, tenant: "t" });
      time.advance(1);
      await vector.send({ eventType: "a.c", payload: { n: 2 }, tenant: "t" });
      await vector.send({ eventType: "a.b", payload: { n: 3 }, tenant: "other" });
      const endpoint = await vector.endpoints.create({
        url: URL_A,
        tenant: "t",
        eventTypes: ["a.b"],
      });
      const result = await vector.replay({ tenant: "t", from, endpointId: endpoint.id });
      expect(result.messages).toBe(2);
      expect(result.deliveries).toHaveLength(1);
      expect(result.truncated).toBe(false);
      const limited = await vector.replay({ tenant: "t", from, limit: 1 });
      expect(limited.truncated).toBe(true);
      await expect(vector.replay({ tenant: undefined as never, from })).rejects.toThrow();
    });

    it("prunes old messages with their deliveries", async () => {
      const store = await fresh();
      const { vector, time } = testVector({ store });
      await vector.endpoints.create({ url: URL_A });
      await vector.send({ eventType: "a.b", payload: {} });
      await vector.process();
      time.advance(3600);
      const { message } = await vector.send({ eventType: "a.b", payload: {} });
      await vector.process();
      const deleted = await vector.prune({
        olderThan: new Date(time.now().getTime() - 1800_000),
        batchSize: 1,
      });
      expect(deleted).toBe(1);
      expect(await vector.messages.list({})).toHaveLength(1);
      expect((await vector.deliveries.list({})).every((d) => d.messageId === message.id)).toBe(
        true,
      );
    });

    it("reports the schema version", async () => {
      const store = await fresh();
      expect(await store.schemaVersion()).toBe(SCHEMA_VERSION);
    });
  });
}

suite("memory", async () => new MemoryStore());
suite("sqlite", async () => {
  const store = createSqliteStore({ database: new DatabaseSync(":memory:") });
  await store.migrate();
  return store;
});
suite("postgres", async () => {
  const db = new PGlite();
  const store = createPostgresStore({
    query: (text, params) => db.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
  });
  await store.migrate();
  return store;
});

describe("upgrade from a 1.x database", () => {
  it("sqlite: adds columns, keeps rows, records the version", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      create table vector_endpoints (id text primary key, tenant text, url text not null, description text, secret text not null, previous_secret text, previous_secret_expires_at integer, event_types text, headers text not null default '{}', metadata text not null default '{}', enabled integer not null default 1, disabled_reason text, failure_streak integer not null default 0, created_at integer not null, updated_at integer not null);
      create table vector_messages (id text primary key, tenant text, event_type text not null, payload text not null, idempotency_key text, created_at integer not null);
      create table vector_deliveries (id text primary key, message_id text not null, endpoint_id text not null, tenant text, event_type text not null, status text not null, attempts integer not null default 0, next_attempt_at integer, locked_until integer, lock_token text, last_attempt_at integer, last_status_code integer, last_error text, created_at integer not null, updated_at integer not null);
      create table vector_attempts (id text primary key, delivery_id text not null, message_id text not null, endpoint_id text not null, tenant text, at integer not null, duration_ms integer not null, status_code integer, success integer not null, error text, response_body text);
      insert into vector_messages (id, tenant, event_type, payload, created_at) values ('msg_old', null, 'a.b', '{"n":1}', 1000);
    `);
    const store = createSqliteStore({ database });
    await store.migrate();
    await store.migrate();
    expect(await store.schemaVersion()).toBe(SCHEMA_VERSION);
    const message = await store.getMessage("msg_old");
    expect(message?.orderingKey).toBeNull();
    const { vector } = testVector({ store });
    await vector.endpoints.create({ url: URL_A, filter: { path: "n", op: "eq", value: 1 } });
    const sent = await vector.send({ eventType: "a.b", payload: { n: 1 }, orderingKey: "k" });
    expect(sent.deliveries).toHaveLength(1);
  });

  it("postgres: running the 2.0 migration over a 1.x schema works", async () => {
    const db = new PGlite();
    await db.exec(`
      create table vector_endpoints (id text primary key, tenant text, url text not null, description text, secret text not null, previous_secret text, previous_secret_expires_at bigint, event_types text, headers jsonb not null default '{}', metadata jsonb not null default '{}', enabled boolean not null default true, disabled_reason text, failure_streak integer not null default 0, created_at timestamptz not null, updated_at timestamptz not null);
    `);
    const store = createPostgresStore({
      query: (text, params) =>
        db.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
    });
    await store.migrate();
    expect(await store.schemaVersion()).toBe(SCHEMA_VERSION);
    const cols = await db.query(
      "select column_name from information_schema.columns where table_name = 'vector_endpoints' and column_name = 'filter'",
    );
    expect(cols.rows).toHaveLength(1);
  });
});

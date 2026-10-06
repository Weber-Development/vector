import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createVector, type VectorStore } from "../src/index";
import { createSqliteStore } from "../src/sqlite";
import { clock, fakeNetwork } from "./helpers";

const URLS = [
  "https://a.example.com/hook",
  "https://b.example.com/hook",
  "https://c.example.com/hook",
];

function build(
  store: VectorStore,
  network: ReturnType<typeof fakeNetwork>,
  time: ReturnType<typeof clock>,
  onError: (error: unknown) => void = (error) => {
    throw error;
  },
) {
  return createVector({
    store,
    fetch: network.fetch,
    now: time.now,
    random: () => 0.5,
    urlPolicy: { resolveHost: async () => ["93.184.215.14"] },
    onError,
  });
}

async function sqliteStore() {
  const store = createSqliteStore({ database: new DatabaseSync(":memory:") });
  await store.migrate();
  return store;
}

/** How often each message reached each URL. */
function tally(network: ReturnType<typeof fakeNetwork>) {
  const counts = new Map<string, number>();
  for (const r of network.received) {
    const key = `${r.headers["webhook-id"]}@${r.url}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe("load", () => {
  it("delivers 1500 messages to 3 endpoints exactly once with four workers on one database", async () => {
    const store = await sqliteStore();
    const network = fakeNetwork();
    const time = clock();
    const workers = Array.from({ length: 4 }, () => build(store, network, time));
    const [sender] = workers as [(typeof workers)[number]];
    for (const url of URLS) await sender.endpoints.create({ url });
    for (const start of [0, 1000]) {
      await sender.sendMany(
        Array.from({ length: Math.min(1000, 1500 - start) }, (_, i) => ({
          eventType: "load.test",
          payload: { i: start + i },
        })),
        { concurrency: 20 },
      );
    }

    let rounds = 0;
    for (;;) {
      const results = await Promise.all(
        workers.map((worker) => worker.process({ limit: 100, concurrency: 10 })),
      );
      rounds++;
      if (results.every((r) => r.claimed === 0)) break;
      expect(rounds).toBeLessThan(100);
    }

    const counts = tally(network);
    expect(counts.size).toBe(4500);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    const deliveries = await store.listDeliveries({ limit: 1000 });
    expect(deliveries).toHaveLength(1000); // the newest page is enough as a sample
    expect(deliveries.every((d) => d.status === "succeeded")).toBe(true);
  });
});

describe("outages", () => {
  it("recovers deliveries that a crashed worker had locked, after the lock expires", async () => {
    const store = await sqliteStore();
    const network = fakeNetwork();
    const time = clock();
    const vector = build(store, network, time);
    await vector.endpoints.create({ url: URLS[0] as string });
    for (let i = 0; i < 20; i++) await vector.send({ eventType: "a.b", payload: { i } });

    // A worker claims the batch and dies before delivering anything.
    const claimed = await store.claimDueDeliveries(
      time.now(),
      50,
      new Date(time.now().getTime() + 75_000),
    );
    expect(claimed).toHaveLength(20);
    expect((await vector.process()).claimed).toBe(0);

    time.advance(30);
    expect((await vector.process()).claimed).toBe(0);
    time.advance(60);
    const result = await vector.process();
    expect(result.succeeded).toBe(20);
    expect([...tally(network).values()].every((n) => n === 1)).toBe(true);
  });

  it("delivers everything after a receiver outage, within the retry schedule", async () => {
    const time = clock();
    let down = true;
    const flaky = fakeNetwork();
    const original = flaky.fetch;
    flaky.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      down ? new Response("down", { status: 503 }) : original(input, init)) as typeof fetch;
    const guarded = build(await sqliteStore(), flaky, time);
    const ep = await guarded.endpoints.create({ url: URLS[0] as string });
    for (let i = 0; i < 30; i++) await guarded.send({ eventType: "a.b", payload: { i } });

    expect((await guarded.process()).retrying).toBe(30);
    time.advance(300);
    expect((await guarded.process()).retrying).toBe(30);
    down = false;
    time.advance(1800);
    const recovered = await guarded.process();
    expect(recovered.succeeded).toBe(30);
    const after = await guarded.endpoints.get(ep.id);
    expect(after?.enabled).toBe(true);
    expect(after?.failureStreak).toBe(0);
    expect(flaky.received.filter((r) => r.url === URLS[0])).toHaveLength(30);
  });

  it("keeps stored messages and resumes when the database fails during processing", async () => {
    const real = await sqliteStore();
    let failing = false;
    const store = new Proxy(real, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (failing && property === "claimDueDeliveries") {
            return Promise.reject(new Error("connection lost"));
          }
          return value.apply(target, args);
        };
      },
    }) as VectorStore;
    const network = fakeNetwork();
    const time = clock();
    const errors: unknown[] = [];
    const vector = build(store, network, time, (error) => errors.push(error));
    await vector.endpoints.create({ url: URLS[0] as string });
    for (let i = 0; i < 10; i++) await vector.send({ eventType: "a.b", payload: { i } });

    failing = true;
    const worker = vector.start({ intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(errors.length).toBeGreaterThan(0);
    expect(network.received).toHaveLength(0);

    failing = false;
    for (let i = 0; i < 100 && network.received.length < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await worker.stop();
    expect(network.received).toHaveLength(10);
    expect([...tally(network).values()].every((n) => n === 1)).toBe(true);
  });

  it("stop() waits for the batch in flight", async () => {
    const time = clock();
    const slow = fakeNetwork();
    let finished = 0;
    slow.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const vector = build(await sqliteStore(), slow, time);
    await vector.endpoints.create({ url: URLS[0] as string });
    for (let i = 0; i < 5; i++) await vector.send({ eventType: "a.b", payload: { i } });
    const worker = vector.start({ intervalMs: 5, concurrency: 5 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await worker.stop();
    expect(finished).toBe(5);
    const deliveries = await vector.deliveries.list({});
    expect(deliveries.every((d) => d.status === "succeeded")).toBe(true);
  });
});

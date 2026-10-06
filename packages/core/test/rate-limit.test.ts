import { describe, expect, it } from "vitest";
import { fakeNetwork, testVector } from "./helpers";

const URL_A = "https://a.example.com/hook";
const URL_B = "https://b.example.com/hook";

async function sendMany(vector: ReturnType<typeof testVector>["vector"], count: number) {
  for (let i = 0; i < count; i++) await vector.send({ eventType: "a.b", payload: { i } });
}

describe("rateLimit", () => {
  it("delays deliveries over the limit without counting an attempt", async () => {
    const network = fakeNetwork();
    const { vector, time } = testVector({ network, rateLimit: 2 });
    await vector.endpoints.create({ url: URL_A });
    await sendMany(vector, 5);

    const first = await vector.process();
    expect(first.claimed).toBe(5);
    expect(first.succeeded).toBe(2); // a burst of two
    expect(first.retrying).toBe(3);
    expect(network.received).toHaveLength(2);

    const none = await vector.process();
    expect(none.claimed).toBe(0);

    time.advance(0.5); // one more slot at 2 per second
    expect((await vector.process()).succeeded).toBe(1);
    time.advance(1);
    expect((await vector.process()).succeeded).toBe(2);
    expect(network.received).toHaveLength(5);

    const deliveries = await vector.store.listDeliveries({});
    expect(deliveries.every((d) => d.status === "succeeded" && d.attempts === 1)).toBe(true);
  });

  it("limits each endpoint on its own, by function or by metadata.rateLimit", async () => {
    const network = fakeNetwork();
    const { vector } = testVector({
      network,
      rateLimit: (endpoint) => (endpoint.url === URL_A ? 1 : undefined),
    });
    await vector.endpoints.create({ url: URL_A });
    await vector.endpoints.create({ url: URL_B });
    const slow = await vector.endpoints.create({
      url: "https://c.example.com/hook",
      metadata: { rateLimit: "1" },
    });
    expect(slow.metadata.rateLimit).toBe("1");
    await sendMany(vector, 3);
    await vector.process();
    const count = (url: string) => network.received.filter((r) => r.url === url).length;
    expect(count(URL_A)).toBe(1);
    expect(count(URL_B)).toBe(3);
    expect(count("https://c.example.com/hook")).toBe(1);
  });

  it("does not hold back test events and manual retries", async () => {
    const network = fakeNetwork();
    const { vector } = testVector({ network, rateLimit: 1 });
    const endpoint = await vector.endpoints.create({ url: URL_A });
    await sendMany(vector, 2);
    await vector.process();
    await vector.sendTest(endpoint.id);
    expect(network.received).toHaveLength(2); // one send, one test; the second send waits
  });

  it("rejects a limit that is not positive", () => {
    expect(() => testVector({ rateLimit: 0 })).toThrow(RangeError);
  });
});

describe("dispatcher", () => {
  it("is passed to fetch", async () => {
    const seen: unknown[] = [];
    const dispatcher = { name: "proxy" };
    const { vector } = testVector({
      dispatcher,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push((init as { dispatcher?: unknown }).dispatcher);
        return new Response("ok");
      }) as typeof fetch,
    });
    await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    expect(seen).toEqual([dispatcher]);
  });
});

import { describe, expect, it } from "vitest";
import type { TransformFunction } from "../src/index";
import { fakeNetwork, testVector, verifyReceived } from "./helpers";

const URL_A = "https://a.example.com/hook";
const URL_B = "https://b.example.com/hook";

describe("transform", () => {
  it("replaces the body and adds headers per endpoint, and signs the new body", async () => {
    const network = fakeNetwork();
    const transform: TransformFunction = ({ endpoint, body }) =>
      endpoint.url === URL_B
        ? {
            body: { text: `got ${(body as { type: string }).type}` },
            headers: { "x-extra": "1", "content-type": "text/plain", "webhook-id": "evil" },
          }
        : undefined;
    const { vector, time } = testVector({ network, transform });
    const a = await vector.endpoints.create({ url: URL_A });
    const b = await vector.endpoints.create({ url: URL_B });
    await vector.send({ eventType: "invoice.paid", payload: { id: 1 }, deliverNow: true });

    const forA = network.received.find((r) => r.url === URL_A);
    const forB = network.received.find((r) => r.url === URL_B);
    expect(JSON.parse(forA?.body ?? "{}")).toMatchObject({ type: "invoice.paid", data: { id: 1 } });
    expect(JSON.parse(forB?.body ?? "{}")).toEqual({ text: "got invoice.paid" });
    expect(forB?.headers["x-extra"]).toBe("1");
    // Vector's own headers cannot be overridden.
    expect(forB?.headers["content-type"]).toBe("application/json");
    expect(forB?.headers["webhook-id"]).toMatch(/^msg_/);
    await expect(verifyReceived(forB as never, b.secret, time.now())).resolves.toBeTruthy();
    await expect(verifyReceived(forA as never, a.secret, time.now())).resolves.toBeTruthy();
  });

  it("skips a delivery with a reason", async () => {
    const network = fakeNetwork();
    const { vector } = testVector({
      network,
      transform: ({ message }) =>
        message.eventType === "noisy.event" ? { skip: "Too noisy" } : {},
    });
    await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "noisy.event", payload: {} });
    await vector.send({ eventType: "other.event", payload: {} });
    const result = await vector.process();
    expect(result).toMatchObject({ claimed: 2, cancelled: 1, succeeded: 1 });
    expect(network.received).toHaveLength(1);
    const [skipped] = await vector.deliveries.list({ status: "cancelled" });
    expect(skipped?.lastError).toBe("Too noisy");
  });

  it("treats a throwing transform as a failed attempt that is retried", async () => {
    const network = fakeNetwork();
    let broken = true;
    const { vector, time } = testVector({
      network,
      retrySchedule: [10],
      transform: () => {
        if (broken) throw new Error("template error");
        return undefined;
      },
    });
    await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: {} });
    expect((await vector.process()).retrying).toBe(1);
    expect(network.received).toHaveLength(0);
    const [attempt] = await vector.attempts.list({});
    expect(attempt).toMatchObject({ success: false, error: "Transform failed: template error" });
    broken = false;
    time.advance(10);
    expect((await vector.process()).succeeded).toBe(1);
  });

  it("rejects a body that is not JSON", async () => {
    const { vector } = testVector({ transform: () => ({ body: undefined }) });
    await vector.endpoints.create({ url: URL_A });
    await vector.send({ eventType: "a.b", payload: {} });
    await vector.process();
    const [attempt] = await vector.attempts.list({});
    expect(attempt?.error).toBe("Transform failed: The transformed body must be JSON.");
  });
});

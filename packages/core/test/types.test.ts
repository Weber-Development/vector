import { describe, expectTypeOf, it } from "vitest";
import {
  type Attempt,
  createVector,
  type Delivery,
  type Endpoint,
  generateKeyPair,
  generateSecret,
  type Message,
  type SendInput,
  type SendResult,
  sign,
  type Vector,
  type VectorEvents,
  type VectorOptions,
  type VectorStore,
  verify,
} from "../src/index";

// These assertions are checked by `tsc` (pnpm typecheck). They pin the public shapes so that a
// change that would break users shows up in review.
describe("public types", () => {
  it("keeps the shapes of the main entry points", () => {
    expectTypeOf(createVector).parameter(0).toEqualTypeOf<VectorOptions | undefined>();
    expectTypeOf(createVector).returns.toEqualTypeOf<Vector>();
    expectTypeOf<Vector["send"]>().parameter(0).toEqualTypeOf<SendInput>();
    expectTypeOf<Vector["send"]>().returns.toEqualTypeOf<Promise<SendResult>>();
    expectTypeOf<Vector["process"]>().returns.resolves.toHaveProperty("succeeded");
    expectTypeOf<Vector["start"]>().returns.toHaveProperty("stop");
    expectTypeOf(generateSecret).returns.toBeString();
    expectTypeOf(generateKeyPair).returns.resolves.toHaveProperty("secretKey");
    expectTypeOf(sign).returns.resolves.toBeString();
    expectTypeOf(verify).returns.resolves.toHaveProperty("payload");
  });

  it("keeps the fields of stored records", () => {
    expectTypeOf<Endpoint>().toHaveProperty("id").toBeString();
    expectTypeOf<Endpoint>().toHaveProperty("enabled").toBeBoolean();
    expectTypeOf<Endpoint>().toHaveProperty("failureStreak").toBeNumber();
    expectTypeOf<Message>().toHaveProperty("eventType").toBeString();
    expectTypeOf<Delivery>().toHaveProperty("status");
    expectTypeOf<Delivery>().toHaveProperty("attempts").toBeNumber();
    expectTypeOf<Attempt>().toHaveProperty("statusCode");
  });

  it("keeps the event names and the store contract", () => {
    expectTypeOf<keyof VectorEvents>().toEqualTypeOf<
      "attempt" | "delivery.succeeded" | "delivery.failed" | "endpoint.disabled"
    >();
    expectTypeOf<VectorStore>().toHaveProperty("claimDueDeliveries");
    expectTypeOf<VectorStore>().toHaveProperty("insertMessage");
    expectTypeOf<VectorStore>().toHaveProperty("listDeliveries");
  });
});

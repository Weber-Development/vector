import { Webhook as StandardWebhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import {
  generateSecret,
  secretToBytes,
  sign,
  signHeaders,
  verify,
  verifyRequest,
  Webhook,
  WebhookVerificationError,
} from "../src/index";

const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const payload = '{"test": 2432232314}';
const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const timestamp = 1614265330;

describe("signatures", () => {
  it("matches the Standard Webhooks test vector", async () => {
    // Test vector from the Standard Webhooks specification repository.
    expect(await sign({ id, timestamp, payload, secret })).toBe(
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
  });

  it("is verified by the official standardwebhooks package", async () => {
    const body = JSON.stringify({ type: "invoice.paid", data: { amount: 4200 } });
    const now = new Date();
    const headers = await signHeaders({ id: "msg_1", timestamp: now, payload: body, secret });
    const official = new StandardWebhook(secret);
    expect(official.verify(body, headers)).toEqual(JSON.parse(body));
  });

  it("verifies what the official package signs", async () => {
    const official = new StandardWebhook(secret);
    const now = new Date();
    const body = '{"type":"x"}';
    const signature = official.sign("msg_2", now, body);
    const result = await verify(
      body,
      {
        "webhook-id": "msg_2",
        "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
        "webhook-signature": signature,
      },
      secret,
    );
    expect(result.payload).toEqual({ type: "x" });
    expect(result.id).toBe("msg_2");
  });

  it("generates secrets in the whsec_ format", () => {
    const generated = generateSecret();
    expect(generated).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(secretToBytes(generated)).toHaveLength(24);
    expect(generateSecret()).not.toBe(generated);
    expect(() => generateSecret(8)).toThrow(RangeError);
  });

  it("rejects a tampered body, a wrong secret and missing headers", async () => {
    const now = new Date();
    const headers = await signHeaders({ id, timestamp: now, payload, secret });
    await expect(verify(`${payload} `, headers, secret)).rejects.toMatchObject({
      code: "no_matching_signature",
    });
    await expect(verify(payload, headers, generateSecret())).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    await expect(verify(payload, { "webhook-id": id }, secret)).rejects.toMatchObject({
      code: "missing_headers",
    });
  });

  it("checks the timestamp tolerance in both directions", async () => {
    const now = new Date("2026-10-05T12:00:00Z");
    const old = await signHeaders({
      id,
      timestamp: new Date(now.getTime() - 6 * 60_000),
      payload,
      secret,
    });
    await expect(verify(payload, old, secret, { now })).rejects.toMatchObject({
      code: "timestamp_too_old",
    });
    const future = await signHeaders({
      id,
      timestamp: new Date(now.getTime() + 6 * 60_000),
      payload,
      secret,
    });
    await expect(verify(payload, future, secret, { now })).rejects.toMatchObject({
      code: "timestamp_too_new",
    });
    await expect(
      verify(payload, old, secret, { now, toleranceSeconds: 600 }),
    ).resolves.toBeTruthy();
    await expect(
      verify(payload, { ...old, "webhook-timestamp": "abc" }, secret, { now }),
    ).rejects.toMatchObject({ code: "invalid_timestamp" });
  });

  it("accepts any of several signatures and several secrets (rotation)", async () => {
    const next = generateSecret();
    const now = new Date();
    const headers = await signHeaders({ id, timestamp: now, payload, secret, secrets: [next] });
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    await expect(verify(payload, headers, next)).resolves.toBeTruthy();
    await expect(verify(payload, headers, secret)).resolves.toBeTruthy();
    const onlyNew = await signHeaders({ id, timestamp: now, payload, secret: next });
    await expect(verify(payload, onlyNew, [secret, next])).resolves.toBeTruthy();
  });

  it("reads svix-* headers, Headers objects and arrays", async () => {
    const now = new Date();
    const h = await signHeaders({ id, timestamp: now, payload, secret });
    await expect(
      verify(
        payload,
        {
          "svix-id": h["webhook-id"],
          "svix-timestamp": h["webhook-timestamp"],
          "svix-signature": h["webhook-signature"],
        },
        secret,
      ),
    ).resolves.toBeTruthy();
    await expect(verify(payload, new Headers(h), secret)).resolves.toBeTruthy();
    await expect(
      verify(payload, { ...h, "Webhook-Signature": [h["webhook-signature"]] }, secret),
    ).resolves.toBeTruthy();
  });

  it("rejects bodies that are not JSON after a valid signature", async () => {
    const h = await signHeaders({ id, timestamp: new Date(), payload: "not json", secret });
    await expect(verify("not json", h, secret)).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("verifies a Fetch API request", async () => {
    const body = JSON.stringify({ type: "user.created", data: { id: 1 } });
    const headers = await signHeaders({ id, timestamp: new Date(), payload: body, secret });
    const request = new Request("https://example.com/hook", { method: "POST", body, headers });
    const result = await verifyRequest<{ type: string }>(request, secret);
    expect(result.payload.type).toBe("user.created");
  });

  it("offers a class API like the standardwebhooks package", async () => {
    const wh = new Webhook(secret);
    const now = new Date();
    const signature = await wh.sign(id, now, payload);
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
      "webhook-signature": signature,
    };
    expect(await wh.verify(payload, headers)).toEqual({ test: 2432232314 });
    expect(() => new Webhook("whsec_***")).toThrow(TypeError);
  });
});

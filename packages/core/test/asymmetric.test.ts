import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  generateSecret,
  publicKeyFor,
  sign,
  signHeaders,
  verify,
  Webhook,
  WebhookVerificationError,
} from "../src/index";
import { fakeNetwork, testVector, verifyReceived } from "./helpers";

const NOW = new Date("2026-10-06T12:00:00Z");
const ID = "msg_ed25519";
const BODY = '{"type":"invoice.paid","data":{"id":"inv_1"}}';

/** Node's own Ed25519 implementation, to check signatures against a second implementation. */
function nodeCheck(publicKey: string, content: string, signature: string): boolean {
  const raw = Buffer.from(publicKey.slice("whpk_".length), "base64");
  // SPKI DER header of an Ed25519 public key.
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  return nodeVerify(null, Buffer.from(content), key, Buffer.from(signature.slice(4), "base64"));
}

describe("Ed25519 (v1a) signatures", () => {
  it("generates whsk_/whpk_ key pairs", async () => {
    const pair = await generateKeyPair();
    expect(pair.secretKey).toMatch(/^whsk_[A-Za-z0-9+/]+=*$/);
    expect(pair.publicKey).toMatch(/^whpk_[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(pair.secretKey.slice(5), "base64")).toHaveLength(64);
    expect(Buffer.from(pair.publicKey.slice(5), "base64")).toHaveLength(32);
    expect(await publicKeyFor(pair.secretKey)).toBe(pair.publicKey);
    expect((await generateKeyPair()).publicKey).not.toBe(pair.publicKey);
  });

  it("signs v1a and verifies with the public key", async () => {
    const { secretKey, publicKey } = await generateKeyPair();
    const signature = await sign({ id: ID, timestamp: NOW, payload: BODY, secret: secretKey });
    expect(signature).toMatch(/^v1a,/);
    const content = `${ID}.${NOW.getTime() / 1000}.${BODY}`;
    expect(nodeCheck(publicKey, content, signature)).toBe(true);

    const headers = await signHeaders({ id: ID, timestamp: NOW, payload: BODY, secret: secretKey });
    const result = await verify(BODY, headers, publicKey, { now: NOW });
    expect(result.payload).toEqual({ type: "invoice.paid", data: { id: "inv_1" } });
    // The secret key verifies too.
    await expect(verify(BODY, headers, secretKey, { now: NOW })).resolves.toBeTruthy();
    expect(await new Webhook(publicKey, { now: NOW }).verify(BODY, headers)).toEqual(
      result.payload,
    );
  });

  it("accepts a 32-byte seed as secret key", async () => {
    const { secretKey, publicKey } = await generateKeyPair();
    const seedOnly = `whsk_${Buffer.from(secretKey.slice(5), "base64").subarray(0, 32).toString("base64")}`;
    expect(await publicKeyFor(seedOnly)).toBe(publicKey);
    const headers = await signHeaders({ id: ID, timestamp: NOW, payload: BODY, secret: seedOnly });
    await expect(verify(BODY, headers, publicKey, { now: NOW })).resolves.toBeTruthy();
  });

  it("rejects tampered bodies, other keys and mixed schemes", async () => {
    const pair = await generateKeyPair();
    const other = await generateKeyPair();
    const hmac = generateSecret();
    const headers = await signHeaders({
      id: ID,
      timestamp: NOW,
      payload: BODY,
      secret: pair.secretKey,
    });
    const fail = (promise: Promise<unknown>) =>
      expect(promise).rejects.toMatchObject({ code: "no_matching_signature" });
    await fail(verify(`${BODY} `, headers, pair.publicKey, { now: NOW }));
    await fail(verify(BODY, headers, other.publicKey, { now: NOW }));
    // An HMAC secret never accepts a v1a signature, a public key never accepts v1.
    await fail(verify(BODY, headers, hmac, { now: NOW }));
    const hmacHeaders = await signHeaders({ id: ID, timestamp: NOW, payload: BODY, secret: hmac });
    await fail(verify(BODY, hmacHeaders, pair.publicKey, { now: NOW }));
    // Garbage in the signature header is ignored, not thrown.
    await fail(
      verify(BODY, { ...headers, "webhook-signature": "v1a,!!! v1a,AAAA" }, pair.publicKey, {
        now: NOW,
      }),
    );
  });

  it("signs with several keys during a rotation and verifies with any", async () => {
    const current = await generateKeyPair();
    const previous = await generateKeyPair();
    const headers = await signHeaders({
      id: ID,
      timestamp: NOW,
      payload: BODY,
      secret: current.secretKey,
      secrets: [previous.secretKey],
    });
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    await expect(verify(BODY, headers, previous.publicKey, { now: NOW })).resolves.toBeTruthy();
    await expect(
      verify(BODY, headers, [current.publicKey, previous.publicKey], { now: NOW }),
    ).resolves.toBeTruthy();
  });

  it("refuses to sign with a public key and validates key formats", async () => {
    const { publicKey } = await generateKeyPair();
    await expect(
      sign({ id: ID, timestamp: NOW, payload: BODY, secret: publicKey }),
    ).rejects.toThrow(TypeError);
    expect(() => new Webhook("whpk_AAAA")).toThrow(TypeError);
    expect(() => new Webhook("whsk_not base64")).toThrow(TypeError);
    expect(new WebhookVerificationError("missing_headers", "x").code).toBe("missing_headers");
  });
});

describe("Ed25519 endpoints", () => {
  it("signs deliveries of endpoints created with signing: ed25519", async () => {
    const network = fakeNetwork();
    const { vector, time } = testVector({ network, signing: "ed25519" });
    const endpoint = await vector.endpoints.create({ url: "https://a.example.com/hook" });
    expect(endpoint.secret).toMatch(/^whsk_/);
    const keys = await vector.endpoints.publicKey(endpoint.id);
    expect(keys).toEqual({
      publicKey: await publicKeyFor(endpoint.secret),
      previousPublicKey: null,
    });

    await vector.send({ eventType: "invoice.paid", payload: { id: 1 }, deliverNow: true });
    const [received] = network.received;
    expect(received?.headers["webhook-signature"]).toMatch(/^v1a,/);
    await expect(
      verifyReceived(received as never, keys?.publicKey as string, time.now()),
    ).resolves.toBeTruthy();
  });

  it("keeps the scheme on rotation and exposes the previous public key", async () => {
    const network = fakeNetwork();
    const { vector, time } = testVector({ network });
    const endpoint = await vector.endpoints.create({
      url: "https://a.example.com/hook",
      signing: "ed25519",
    });
    const before = await vector.endpoints.publicKey(endpoint.id);
    const rotated = await vector.endpoints.rotateSecret(endpoint.id);
    expect(rotated?.secret).toMatch(/^whsk_/);
    const after = await vector.endpoints.publicKey(endpoint.id);
    expect(after?.previousPublicKey).toBe(before?.publicKey);
    expect(after?.publicKey).not.toBe(before?.publicKey);

    await vector.send({ eventType: "a.b", payload: {}, deliverNow: true });
    const [received] = network.received;
    expect(received?.headers["webhook-signature"]?.split(" ")).toHaveLength(2);
    // Old receivers keep working during the grace period.
    await expect(
      verifyReceived(received as never, before?.publicKey as string, time.now()),
    ).resolves.toBeTruthy();

    time.advance(86_401);
    expect((await vector.endpoints.publicKey(endpoint.id))?.previousPublicKey).toBeNull();
  });

  it("returns null for HMAC endpoints and undefined for unknown ones", async () => {
    const { vector } = testVector({});
    const endpoint = await vector.endpoints.create({ url: "https://a.example.com/hook" });
    expect(endpoint.secret).toMatch(/^whsec_/);
    expect(await vector.endpoints.publicKey(endpoint.id)).toBeNull();
    expect(await vector.endpoints.publicKey("ep_missing")).toBeUndefined();
    expect(await vector.endpoints.publicKey(endpoint.id, { tenant: "other" })).toBeUndefined();
  });

  it("accepts own secret keys and rejects public keys and unknown schemes", async () => {
    const { vector } = testVector({});
    const pair = await generateKeyPair();
    const own = await vector.endpoints.create({
      url: "https://a.example.com/hook",
      secret: pair.secretKey,
    });
    expect((await vector.endpoints.publicKey(own.id))?.publicKey).toBe(pair.publicKey);
    await expect(
      vector.endpoints.create({ url: "https://a.example.com/hook", secret: pair.publicKey }),
    ).rejects.toThrow(TypeError);
    await expect(
      vector.endpoints.create({ url: "https://a.example.com/hook", signing: "rsa" as never }),
    ).rejects.toThrow(TypeError);
  });
});

import {
  assertKey,
  isPublicKey,
  isSecretKey,
  PUBLIC_KEY_PREFIX,
  publicKeyFor,
  SECRET_KEY_PREFIX,
  signEd25519,
  verifyEd25519,
} from "./asymmetric";
import { fromBase64, randomBytes, timingSafeEqual, toBase64, utf8 } from "./encoding";

/** Header names from the Standard Webhooks specification (also used by Svix as `svix-*`). */
export const HEADER_ID = "webhook-id";
export const HEADER_TIMESTAMP = "webhook-timestamp";
export const HEADER_SIGNATURE = "webhook-signature";

const SECRET_PREFIX = "whsec_";
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

/**
 * A symmetric `whsec_` secret (or its raw bytes) for `v1` HMAC signatures, or an Ed25519 key for
 * `v1a` signatures: the sender signs with a `whsk_` secret key, receivers verify with the
 * `whpk_` public key.
 */
export type WebhookSecret = string | Uint8Array;

export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>
  | Iterable<[string, string]>;

export type VerificationErrorCode =
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_too_old"
  | "timestamp_too_new"
  | "no_matching_signature"
  | "invalid_payload";

export class WebhookVerificationError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode, message: string) {
    super(message);
    this.name = "WebhookVerificationError";
    this.code = code;
  }
}

/** Creates a new random signing secret in the Standard Webhooks format (`whsec_` + base64). */
export function generateSecret(byteLength = 24): string {
  if (byteLength < 24 || byteLength > 64) {
    throw new RangeError("Secrets must be between 24 and 64 bytes long.");
  }
  return SECRET_PREFIX + toBase64(randomBytes(byteLength));
}

/** Turns a `whsec_...` string (or raw bytes) into the key bytes. */
export function secretToBytes(secret: WebhookSecret): Uint8Array {
  if (typeof secret !== "string") return secret;
  if (secret.startsWith(SECRET_KEY_PREFIX) || secret.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new TypeError("whsk_ and whpk_ keys are Ed25519 keys, not HMAC secrets.");
  }
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  try {
    return fromBase64(body);
  } catch {
    throw new TypeError("The webhook secret must be base64, optionally prefixed with whsec_.");
  }
}

const keyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();
const stringKeyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: WebhookSecret): Promise<CryptoKey> {
  if (typeof secret === "string") {
    let key = stringKeyCache.get(secret);
    if (!key) {
      key = importBytes(secretToBytes(secret));
      if (stringKeyCache.size > 500) stringKeyCache.clear();
      stringKeyCache.set(secret, key);
    }
    return key;
  }
  let key = keyCache.get(secret);
  if (!key) {
    key = importBytes(secret);
    keyCache.set(secret, key);
  }
  return key;
}

function importBytes(bytes: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    bytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toSeconds(timestamp: Date | number): number {
  return timestamp instanceof Date ? Math.floor(timestamp.getTime() / 1000) : Math.floor(timestamp);
}

function payloadToString(payload: string | Uint8Array): string {
  return typeof payload === "string" ? payload : new TextDecoder().decode(payload);
}

export interface SignInput {
  /** Unique message id, the same for every retry of a message. */
  id: string;
  /** Time of this attempt, as a Date or Unix seconds. */
  timestamp: Date | number;
  /** The exact body that is sent. */
  payload: string | Uint8Array;
  secret: WebhookSecret;
}

function signedContent(id: string, timestamp: Date | number, payload: string | Uint8Array) {
  return `${id}.${toSeconds(timestamp)}.${payloadToString(payload)}`;
}

/**
 * Returns the signature: `v1,<base64>` (HMAC-SHA256) for a `whsec_` secret, `v1a,<base64>`
 * (Ed25519) for a `whsk_` secret key.
 */
export async function sign(input: SignInput): Promise<string> {
  const content = signedContent(input.id, input.timestamp, input.payload);
  if (isSecretKey(input.secret)) return signEd25519(utf8(content), input.secret);
  if (isPublicKey(input.secret)) {
    throw new TypeError("A whpk_ public key can only verify. Sign with the whsk_ secret key.");
  }
  const key = await importKey(input.secret);
  const mac = await globalThis.crypto.subtle.sign("HMAC", key, utf8(content) as BufferSource);
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

/** Builds the three `webhook-*` headers for a request body. */
export async function signHeaders(input: SignInput & { secrets?: WebhookSecret[] }): Promise<{
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}> {
  const secrets = [input.secret, ...(input.secrets ?? [])];
  const signatures = await Promise.all(secrets.map((secret) => sign({ ...input, secret })));
  return {
    [HEADER_ID]: input.id,
    [HEADER_TIMESTAMP]: String(toSeconds(input.timestamp)),
    [HEADER_SIGNATURE]: signatures.join(" "),
  };
}

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  const entries: Iterable<[string, unknown]> =
    Symbol.iterator in (headers as object)
      ? (headers as Iterable<[string, string]>)
      : Object.entries(headers as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) return value.join(" ");
    if (typeof value === "string") return value;
  }
  return undefined;
}

export interface VerifyOptions {
  /** Allowed clock difference in seconds. Default 300 (five minutes). */
  toleranceSeconds?: number;
  /** Current time, for tests. */
  now?: Date;
}

export interface VerifiedWebhook<T = unknown> {
  id: string;
  timestamp: Date;
  /** The parsed JSON body. */
  payload: T;
  /** The body as it was signed. */
  raw: string;
}

/**
 * Verifies a webhook the way the Standard Webhooks specification describes it, and parses the
 * JSON body. Accepts `webhook-*` and `svix-*` headers. Pass several secrets while you rotate one.
 * A `whsec_` secret checks `v1` (HMAC) signatures, a `whpk_` public key checks `v1a` (Ed25519)
 * signatures.
 *
 * Always pass the raw body exactly as received; a re-serialised JSON object will not match.
 */
export async function verify<T = unknown>(
  payload: string | Uint8Array,
  headers: HeaderSource,
  secret: WebhookSecret | WebhookSecret[],
  options: VerifyOptions = {},
): Promise<VerifiedWebhook<T>> {
  const id = readHeader(headers, HEADER_ID) ?? readHeader(headers, "svix-id");
  const timestampHeader =
    readHeader(headers, HEADER_TIMESTAMP) ?? readHeader(headers, "svix-timestamp");
  const signatureHeader =
    readHeader(headers, HEADER_SIGNATURE) ?? readHeader(headers, "svix-signature");
  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError(
      "missing_headers",
      "The webhook-id, webhook-timestamp or webhook-signature header is missing.",
    );
  }
  if (!/^\d+$/.test(timestampHeader)) {
    throw new WebhookVerificationError("invalid_timestamp", "The timestamp is not a number.");
  }
  const timestamp = Number(timestampHeader);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (now - timestamp > tolerance) {
    throw new WebhookVerificationError("timestamp_too_old", "The webhook timestamp is too old.");
  }
  if (timestamp - now > tolerance) {
    throw new WebhookVerificationError(
      "timestamp_too_new",
      "The webhook timestamp is in the future.",
    );
  }

  const raw = payloadToString(payload);
  const parts = signatureHeader.split(" ").map((part) => part.trim());
  const symmetric = parts.filter((part) => part.startsWith("v1,"));
  const asymmetric = parts.filter((part) => part.startsWith("v1a,"));
  const secrets = Array.isArray(secret) ? secret : [secret];
  let matched = false;
  for (const candidate of secrets) {
    if (isPublicKey(candidate) || isSecretKey(candidate)) {
      const publicKey = isPublicKey(candidate) ? candidate : await publicKeyFor(candidate);
      const content = utf8(signedContent(id, timestamp, raw));
      for (const signature of asymmetric) {
        if (await verifyEd25519(content, signature, publicKey)) matched = true;
      }
      continue;
    }
    const expected = await sign({ id, timestamp, payload: raw, secret: candidate });
    for (const signature of symmetric) {
      if (timingSafeEqual(signature, expected)) matched = true;
    }
  }
  if (!matched) {
    throw new WebhookVerificationError(
      "no_matching_signature",
      "No signature matches. Check the secret and that you pass the raw request body.",
    );
  }

  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    throw new WebhookVerificationError("invalid_payload", "The body is not valid JSON.");
  }
  return { id, timestamp: new Date(timestamp * 1000), payload: parsed, raw };
}

/** Reads and verifies a Fetch API `Request` (Next.js route handlers, Hono, Bun, Deno, Workers). */
export async function verifyRequest<T = unknown>(
  request: Request,
  secret: WebhookSecret | WebhookSecret[],
  options?: VerifyOptions,
): Promise<VerifiedWebhook<T>> {
  const body = await request.text();
  return verify<T>(body, request.headers, secret, options);
}

/** Class API compatible with the `standardwebhooks` and `svix` packages. */
export class Webhook {
  private readonly secrets: WebhookSecret[];
  private readonly options: VerifyOptions;

  constructor(secret: WebhookSecret | WebhookSecret[], options: VerifyOptions = {}) {
    this.secrets = Array.isArray(secret) ? secret : [secret];
    if (this.secrets.length === 0) throw new TypeError("At least one secret is required.");
    for (const s of this.secrets) {
      if (isSecretKey(s) || isPublicKey(s)) assertKey(s);
      else secretToBytes(s);
    }
    this.options = options;
  }

  verify<T = unknown>(payload: string | Uint8Array, headers: HeaderSource): Promise<T> {
    return verify<T>(payload, headers, this.secrets, this.options).then((result) => result.payload);
  }

  sign(id: string, timestamp: Date | number, payload: string | Uint8Array): Promise<string> {
    return sign({ id, timestamp, payload, secret: this.secrets[0] as WebhookSecret });
  }
}

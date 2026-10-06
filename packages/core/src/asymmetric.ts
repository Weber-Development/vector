import { fromBase64, toBase64 } from "./encoding";

// Asymmetric signatures from the Standard Webhooks specification: Ed25519 over the same
// `{id}.{timestamp}.{body}` content, sent as `v1a,<base64>`. The sender keeps a `whsk_` secret
// key; receivers only need the `whpk_` public key, so they cannot forge webhooks.

export const SECRET_KEY_PREFIX = "whsk_";
export const PUBLIC_KEY_PREFIX = "whpk_";

// DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface KeyPair {
  /** Keep on the sender: `whsk_` + base64 of the 32-byte seed and the 32-byte public key. */
  secretKey: string;
  /** Give to receivers: `whpk_` + base64 of the 32-byte public key. */
  publicKey: string;
}

export function isSecretKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_KEY_PREFIX);
}

export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PUBLIC_KEY_PREFIX);
}

function decode(value: string, prefix: string, what: string): Uint8Array {
  try {
    return fromBase64(value.slice(prefix.length));
  } catch {
    throw new TypeError(`The ${what} must be ${prefix} followed by base64.`);
  }
}

/** The 32-byte seed of a `whsk_` key. Accepts the seed alone or seed + public key (libsodium). */
function seedOf(secretKey: string): Uint8Array {
  const bytes = decode(secretKey, SECRET_KEY_PREFIX, "secret key");
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new TypeError("An Ed25519 secret key (whsk_) must be 32 or 64 bytes.");
  }
  return bytes.slice(0, 32);
}

function publicBytesOf(publicKey: string): Uint8Array {
  const bytes = decode(publicKey, PUBLIC_KEY_PREFIX, "public key");
  if (bytes.length !== 32) throw new TypeError("An Ed25519 public key (whpk_) must be 32 bytes.");
  return bytes;
}

/** Throws a TypeError when the value is not a well-formed `whsk_` or `whpk_` key. */
export function assertKey(value: string): void {
  if (isSecretKey(value)) seedOf(value);
  else if (isPublicKey(value)) publicBytesOf(value);
  else throw new TypeError("Expected a whsk_ secret key or a whpk_ public key.");
}

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("Ed25519 signatures need the Web Crypto API (crypto.subtle).");
  return value;
}

const privateKeys = new Map<string, Promise<CryptoKey>>();
const publicKeys = new Map<string, Promise<CryptoKey>>();

function cached(
  cache: Map<string, Promise<CryptoKey>>,
  key: string,
  load: () => Promise<CryptoKey>,
): Promise<CryptoKey> {
  let value = cache.get(key);
  if (!value) {
    value = load();
    // Do not keep a failed import around.
    value.catch(() => cache.delete(key));
    if (cache.size > 500) cache.clear();
    cache.set(key, value);
  }
  return value;
}

function importPrivate(secretKey: string, extractable = false): Promise<CryptoKey> {
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(seedOf(secretKey), PKCS8_PREFIX.length);
  return subtle().importKey("pkcs8", der as BufferSource, { name: "Ed25519" }, extractable, [
    "sign",
  ]);
}

function importPublic(publicKey: string): Promise<CryptoKey> {
  return subtle().importKey(
    "raw",
    publicBytesOf(publicKey) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

/** Creates a new Ed25519 key pair in the Standard Webhooks format. */
export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await subtle().generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await subtle().exportKey("jwk", pair.privateKey);
  if (!jwk.d || !jwk.x) throw new Error("This runtime cannot export Ed25519 keys.");
  const seed = fromBase64(jwk.d);
  const pub = fromBase64(jwk.x);
  const secret = new Uint8Array(64);
  secret.set(seed);
  secret.set(pub, 32);
  return {
    secretKey: SECRET_KEY_PREFIX + toBase64(secret),
    publicKey: PUBLIC_KEY_PREFIX + toBase64(pub),
  };
}

/** The `whpk_` public key that belongs to a `whsk_` secret key. */
export async function publicKeyFor(secretKey: string): Promise<string> {
  const key = await importPrivate(secretKey, true);
  const jwk = await subtle().exportKey("jwk", key);
  if (!jwk.x) throw new Error("This runtime cannot export Ed25519 keys.");
  return PUBLIC_KEY_PREFIX + toBase64(fromBase64(jwk.x));
}

/** Signs the content with a `whsk_` key and returns `v1a,<base64>`. */
export async function signEd25519(content: Uint8Array, secretKey: string): Promise<string> {
  const key = await cached(privateKeys, secretKey, () => importPrivate(secretKey));
  const signature = await subtle().sign("Ed25519", key, content as BufferSource);
  return `v1a,${toBase64(new Uint8Array(signature))}`;
}

/** Checks one `v1a,<base64>` signature against a `whpk_` public key. */
export async function verifyEd25519(
  content: Uint8Array,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  if (!signature.startsWith("v1a,")) return false;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(signature.slice(4));
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  const key = await cached(publicKeys, publicKey, () => importPublic(publicKey));
  return subtle().verify("Ed25519", key, bytes as BufferSource, content as BufferSource);
}

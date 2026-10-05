const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. Works in Node, browsers and edge runtimes. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64.charAt((n >> 18) & 63) +
      B64.charAt((n >> 12) & 63) +
      B64.charAt((n >> 6) & 63) +
      B64.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}${B64.charAt((n >> 6) & 63)}=`;
  }
  return out;
}

const LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) LOOKUP[B64[i] as string] = i;
LOOKUP["-"] = 62;
LOOKUP._ = 63;

/** Decodes standard or URL-safe base64, with or without padding. Throws on invalid input. */
export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/_-]*$/.test(clean) || clean.length % 4 === 1) {
    throw new Error("Invalid base64");
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | (LOOKUP[char] as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** Compares two strings in time that depends only on their length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

const ID_ALPHABET = "0123456789abcdefghijkmnpqrstuvwxyz";

/**
 * Sortable random id with a prefix, e.g. `msg_2kq9...`. The first part is the time in
 * milliseconds, so ids created later sort after earlier ones.
 */
export function createId(prefix: string, now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 9; i++) {
    time = ID_ALPHABET[t % ID_ALPHABET.length] + time;
    t = Math.floor(t / ID_ALPHABET.length);
  }
  let random = "";
  for (const byte of randomBytes(14)) random += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}_${time}${random}`;
}

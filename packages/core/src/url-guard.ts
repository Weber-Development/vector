/**
 * Protection against server-side request forgery: endpoint URLs come from your customers, so
 * Vector refuses to send to localhost, private networks, link-local addresses (cloud metadata
 * at 169.254.169.254) and similar, unless you allow it.
 */

export interface UrlPolicy {
  /** Allow private, loopback and link-local targets. Only for development and trusted setups. */
  allowPrivateNetworks?: boolean;
  /** Allow plain `http:`. Default: only when `allowPrivateNetworks` is set. */
  allowHttp?: boolean;
  /**
   * Resolves a host name to IP addresses. Defaults to `node:dns` on Node.js. On runtimes without
   * DNS access (browsers, edge) host names are not resolved, only IP literals are checked.
   */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export class UrlNotAllowedError extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`Endpoint URL not allowed: ${reason}`);
    this.name = "UrlNotAllowedError";
    this.url = url;
  }
}

function parseIPv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function isPrivateIPv4(bytes: number[]): boolean {
  const [a = 0, b = 0, c = 0] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIPv6(value: string): number[] | null {
  let address = value.toLowerCase();
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  let tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  const maybeV4 = address.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    tail = [(a << 8) | b, (c << 8) | d];
    address = `${address.slice(0, lastColon + 1)}0:0`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const parsed = groups.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  if (parsed.some(Number.isNaN) || parsed.length !== 8) return null;
  if (tail.length) parsed.splice(6, 2, ...tail);
  return parsed;
}

function isPrivateIPv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d carry an IPv4 address.
  if ((zeroPrefix && g5 === 0xffff) || (g0 === 0x64 && g1 === 0xff9b)) {
    return isPrivateIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) // documentation
  );
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPrivateIPv4(v4);
  const v6 = expandIPv6(ip.replace(/^\[|\]$/g, ""));
  if (v6) return isPrivateIPv6(v6);
  return true; // not an address we understand: refuse
}

function isIpLiteral(hostname: string): boolean {
  return parseIPv4(hostname) !== null || hostname.includes(":");
}

type DnsModule = {
  promises: { lookup(host: string, options: { all: true }): Promise<{ address: string }[]> };
};

function defaultResolver(): ((hostname: string) => Promise<string[]>) | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const dns = proc?.getBuiltinModule?.("node:dns") as DnsModule | undefined;
  if (!dns) return undefined;
  return async (hostname) =>
    (await dns.promises.lookup(hostname, { all: true })).map((r) => r.address);
}

/**
 * Throws `UrlNotAllowedError` unless the URL may receive webhooks under the policy. Call it when
 * an endpoint is created and before every attempt (DNS can change in between).
 */
export async function assertDeliverableUrl(url: string, policy: UrlPolicy = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlNotAllowedError(url, "not a valid URL");
  }
  const allowHttp = policy.allowHttp ?? policy.allowPrivateNetworks ?? false;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new UrlNotAllowedError(url, allowHttp ? "only http and https" : "only https");
  }
  if (parsed.username || parsed.password) {
    throw new UrlNotAllowedError(url, "credentials in the URL are not allowed, use headers");
  }
  if (policy.allowPrivateNetworks) return parsed;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal")
  ) {
    throw new UrlNotAllowedError(url, `${hostname} is a local host name`);
  }
  if (isIpLiteral(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UrlNotAllowedError(url, `${hostname} is a private or reserved address`);
    }
    return parsed;
  }
  const resolve = policy.resolveHost ?? defaultResolver();
  if (!resolve) return parsed;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new UrlNotAllowedError(url, `${hostname} could not be resolved`);
  }
  if (addresses.length === 0) throw new UrlNotAllowedError(url, `${hostname} has no address`);
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) {
    throw new UrlNotAllowedError(url, `${hostname} resolves to the private address ${blocked}`);
  }
  return parsed;
}

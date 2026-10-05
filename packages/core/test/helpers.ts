import { createVector, type VectorOptions, verify } from "../src/index";

export interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake network: answers per URL with a queue of status codes (last one repeats). */
export function fakeNetwork(responses: Record<string, Array<number | Error | Response>> = {}) {
  const received: Received[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    received.push({ url, headers, body: String(init?.body) });
    const queue = responses[url] ?? [200];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return new Response(next === 204 ? null : `status ${next}`, { status: next ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, received };
}

export function clock(start = "2026-10-05T12:00:00Z") {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

export function testVector(options: VectorOptions & { network?: ReturnType<typeof fakeNetwork> }) {
  const network = options.network ?? fakeNetwork();
  const time = clock();
  const vector = createVector({
    fetch: network.fetch,
    now: time.now,
    random: () => 0.5,
    urlPolicy: { resolveHost: async () => ["93.184.215.14"] },
    onError: (error) => {
      throw error;
    },
    ...options,
  });
  return { vector, network, time };
}

export async function verifyReceived(received: Received, secret: string, now: Date) {
  return verify(received.body, received.headers, secret, { now });
}

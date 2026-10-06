import { checkPrefix } from "./sql";

/**
 * Remembers the ids of webhooks a receiver has handled. Webhooks are delivered at least once, so
 * the same `webhook-id` can arrive again after a retry; `claim` tells the first time from the rest.
 */
export interface Deduper {
  /** Remembers `id`. Returns `true` the first time (go ahead), `false` for a repeat. */
  claim(id: string): Promise<boolean>;
  /** Forgets `id`, so the next delivery counts as new. Use it when handling failed. */
  release(id: string): Promise<void>;
  /** Deletes expired ids and returns how many; for SQL dedupers, call it now and then. */
  prune(): Promise<number>;
}

export interface DedupeOptions {
  /** How long an id is remembered, in seconds. Default 7 days, longer than the retry schedule. */
  ttlSeconds?: number;
  /** Clock, for tests. */
  now?: () => Date;
}

const DEFAULT_TTL_SECONDS = 7 * 86_400;

export interface MemoryDeduperOptions extends DedupeOptions {
  /** Most ids kept; the oldest are dropped first. Default 100000. */
  maxEntries?: number;
}

/** Keeps ids in memory: right for one process, lost on restart. */
export function memoryDeduper(options: MemoryDeduperOptions = {}): Deduper {
  const ttl = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const max = options.maxEntries ?? 100_000;
  const now = options.now ?? (() => new Date());
  const seen = new Map<string, number>();
  const prune = async () => {
    const at = now().getTime();
    let removed = 0;
    for (const [id, expires] of seen) {
      if (expires <= at) {
        seen.delete(id);
        removed++;
      }
    }
    return removed;
  };
  return {
    async claim(id) {
      const at = now().getTime();
      const expires = seen.get(id);
      if (expires !== undefined && expires > at) return false;
      seen.delete(id);
      seen.set(id, at + ttl);
      while (seen.size > max) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      return true;
    },
    async release(id) {
      seen.delete(id);
    },
    prune,
  };
}

/** What a SQL dedupe table needs; implemented per database in the `/postgres`, `/sqlite` and `/mysql` entries. */
export interface DedupeDriver {
  /** Deletes the row of `id` if it has expired. */
  deleteExpired(table: string, id: string, nowMs: number): Promise<void>;
  /** Inserts the row; `false` when it exists already. */
  insert(table: string, id: string, expiresMs: number): Promise<boolean>;
  remove(table: string, id: string): Promise<void>;
  deleteAllExpired(table: string, nowMs: number): Promise<number>;
  run(sql: string): Promise<void>;
}

export interface SqlDeduperOptions extends DedupeOptions {
  /** Prefix of the table `<prefix>seen`. Default `vector_`. */
  tablePrefix?: string;
}

export interface SqlDeduper extends Deduper {
  /** Creates the table if it does not exist. Safe to call on every start. */
  migrate(): Promise<void>;
}

export function sqlDeduper(
  driver: DedupeDriver,
  schema: (table: string) => string[],
  options: SqlDeduperOptions = {},
): SqlDeduper {
  const table = `${checkPrefix(options.tablePrefix ?? "vector_")}seen`;
  const ttl = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const now = options.now ?? (() => new Date());
  return {
    async migrate() {
      for (const statement of schema(table)) await driver.run(statement);
    },
    async claim(id) {
      const at = now().getTime();
      await driver.deleteExpired(table, id, at);
      return driver.insert(table, id, at + ttl);
    },
    release: (id) => driver.remove(table, id),
    prune: () => driver.deleteAllExpired(table, now().getTime()),
  };
}

export type OnceResult<T> = { duplicate: true } | { duplicate: false; result: T };

/**
 * Runs `work` only the first time `id` is seen. If `work` throws, the id is forgotten so the
 * retry of the webhook is handled again, and the error is rethrown.
 *
 * ```ts
 * const { id, payload } = await verifyRequest(request, secret);
 * const outcome = await once(deduper, id, () => handle(payload));
 * return new Response(null, { status: 204 }); // also for duplicates
 * ```
 */
export async function once<T>(
  deduper: Deduper,
  id: string,
  work: () => T | Promise<T>,
): Promise<OnceResult<T>> {
  if (!(await deduper.claim(id))) return { duplicate: true };
  try {
    return { duplicate: false, result: await work() };
  } catch (error) {
    await deduper.release(id).catch(() => {});
    throw error;
  }
}

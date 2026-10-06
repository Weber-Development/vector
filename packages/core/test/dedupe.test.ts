import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { type Deduper, memoryDeduper, once } from "../src/index";
import { type MysqlQuery, mysqlDeduper } from "../src/mysql";
import { postgresDeduper } from "../src/postgres";
import { sqliteDeduper } from "../src/sqlite";
import { clock } from "./helpers";

function suite(name: string, make: (now: () => Date) => Promise<Deduper>) {
  describe(name, () => {
    it("claims an id once, forgets it after release, and after the ttl", async () => {
      const time = clock();
      const deduper = await make(time.now);
      expect(await deduper.claim("msg_1")).toBe(true);
      expect(await deduper.claim("msg_1")).toBe(false);
      expect(await deduper.claim("msg_2")).toBe(true);
      await deduper.release("msg_1");
      expect(await deduper.claim("msg_1")).toBe(true);
      time.advance(61);
      expect(await deduper.claim("msg_1")).toBe(true); // expired, so new again
      time.advance(61);
      expect(await deduper.prune()).toBeGreaterThanOrEqual(2);
    });

    it("runs work once and retries after a failure", async () => {
      const deduper = await make(clock().now);
      let runs = 0;
      expect(await once(deduper, "a", () => ++runs)).toEqual({ duplicate: false, result: 1 });
      expect(await once(deduper, "a", () => ++runs)).toEqual({ duplicate: true });
      await expect(
        once(deduper, "b", () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await once(deduper, "b", () => "ok")).toEqual({ duplicate: false, result: "ok" });
      expect(runs).toBe(1);
    });
  });
}

suite("memoryDeduper", async (now) => memoryDeduper({ ttlSeconds: 60, now }));

suite("sqliteDeduper", async (now) => {
  const deduper = sqliteDeduper({ database: new DatabaseSync(":memory:"), ttlSeconds: 60, now });
  await deduper.migrate();
  await deduper.migrate();
  return deduper;
});

suite("postgresDeduper", async (now) => {
  const db = new PGlite();
  const deduper = postgresDeduper({
    query: (text, params) => db.query(text, params) as Promise<{ rows: Record<string, unknown>[] }>,
    ttlSeconds: 60,
    now,
  });
  await deduper.migrate();
  await deduper.migrate();
  return deduper;
});

if (process.env.VECTOR_MYSQL_URL) {
  suite("mysqlDeduper", async (now) => {
    const { createPool } = await import("mysql2/promise");
    const { mysql2Query } = await import("../src/mysql");
    const pool = createPool(process.env.VECTOR_MYSQL_URL as string);
    const query: MysqlQuery = mysql2Query(pool);
    await query("drop table if exists vector_seen", []);
    const deduper = mysqlDeduper({ query, ttlSeconds: 60, now });
    await deduper.migrate();
    return deduper;
  });
}

describe("memoryDeduper limits", () => {
  it("drops the oldest ids beyond maxEntries", async () => {
    const deduper = memoryDeduper({ maxEntries: 2 });
    await deduper.claim("a");
    await deduper.claim("b");
    await deduper.claim("c");
    expect(await deduper.claim("a")).toBe(true);
    expect(await deduper.claim("c")).toBe(false);
  });
});

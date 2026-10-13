/**
 * `ReadWorkerPool` runs a read on a worker, returns what the server's own
 * main-thread pool would have returned for it, and gives up a running read
 * when asked to.
 *
 * A long read here is a recursive CTE counting to fifty million, which takes
 * seconds of CPU. Every claim that turns on a read still running is made while
 * that read is in progress and against work measured in milliseconds, and a
 * read that is cancelled has to fail with SQLite's own interrupt as its
 * cause, which only a statement SQLite stopped reports. A regression that
 * keeps a read from being interrupted fails these cases once the count ends,
 * rather than hanging them.
 */

import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { ensureColumnOriginAvailable } from "../v2/sqlite/column-origin.ts";
import { ReadConnectionPool } from "../v2/sqlite/read-pool.ts";
import { ReadWorkerPool } from "../v2/sqlite/read-worker-pool.ts";

// The comparison pool reads column origins on this thread.
await ensureColumnOriginAvailable();

const LONG_READ =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c " +
  "LIMIT 50000000) SELECT count(*) AS n FROM c";

/** Whether `promise` has settled, read without waiting for it. */
function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(() => settled = true, () => settled = true);
  return () => settled;
}

/**
 * The message of `error`'s cause. SQLite reports an interrupt as `interrupted`
 * from a statement it stopped while stepping and `9: interrupted` from one it
 * stopped while preparing.
 */
function causeMessage(error: Error): string | undefined {
  return error.cause instanceof Error ? error.cause.message : undefined;
}

/** The error `promise` rejects with; fails the case when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-error: ${String(error)}`);
  }
  throw new Error("resolved, where a rejection was expected");
}

describe("ReadWorkerPool", () => {
  let path: string;
  let pool: ReadWorkerPool;

  beforeEach(() => {
    path = Deno.makeTempFileSync({ suffix: ".sqlite" });
    const seed = new Database(path);
    seed.exec("CREATE TABLE t (k TEXT, n INTEGER, b BLOB, j TEXT)");
    seed.exec(
      "INSERT INTO t VALUES " +
        "('a', 4294967303, x'0102', '{\"x\":1}'), " +
        "('b', 9007199254740993, NULL, json_object('y', 2))",
    );
    seed.close();
  });

  afterEach(async () => {
    await pool.close();
    Deno.removeSync(path);
  });

  describe("constructor()", () => {
    it("throws given fewer than one worker", () => {
      pool = new ReadWorkerPool();
      expect(() => new ReadWorkerPool({ maxWorkers: 0 })).toThrow(RangeError);
    });
  });

  describe("instance members", () => {
    describe("query()", () => {
      it("returns the rows `ReadConnectionPool` returns for the same read", async () => {
        pool = new ReadWorkerPool();
        const sql = "SELECT k AS key, n, b, j FROM t ORDER BY k";
        const local = new ReadConnectionPool();
        try {
          const { rows, columns } = await pool.query(path, sql, undefined, {
            labeled: false,
          });
          expect(rows).toEqual(local.query(path, sql));
          expect(rows.length).toBe(2);
          expect(columns).toBeUndefined();
        } finally {
          local.close();
        }
      });

      it("returns whole integers and each column's origin for a labeled read", async () => {
        pool = new ReadWorkerPool();
        const sql = "SELECT k AS key, n, upper(k) AS u FROM t WHERE k = ?";
        const local = new ReadConnectionPool();
        try {
          const result = await pool.query(path, sql, ["b"], { labeled: true });
          expect(result).toEqual(local.queryWithOrigins(path, sql, ["b"]));
          expect(result.rows[0].n).toBe(9007199254740993n);
          expect(result.columns).toEqual([
            { output: "key", table: "t", column: "k" },
            { output: "n", table: "t", column: "n" },
            { output: "u", table: null, column: null },
          ]);
        } finally {
          local.close();
        }
      });

      it("throws the error the read threw, by name and message", async () => {
        pool = new ReadWorkerPool();
        const error = await rejectionOf(
          pool.query(path, "SELECT * FROM missing", undefined, {
            labeled: false,
          }),
        );
        expect(error.message).toContain("no such table: missing");
        expect(error.name).toBe("Error");
      });

      it("throws for a file that cannot be opened", async () => {
        pool = new ReadWorkerPool();
        const missing = `${path}.absent`;
        await expect(
          pool.query(missing, "SELECT 1", undefined, { labeled: false }),
        ).rejects.toThrow();
      });

      it("throws a `GuardError` for a statement that is not a read", async () => {
        pool = new ReadWorkerPool();
        const error = await rejectionOf(
          pool.query(path, "DELETE FROM t", undefined, { labeled: false }),
        );
        expect(error.name).toBe("GuardError");
        const { rows } = await pool.query(
          path,
          "SELECT count(*) AS c FROM t",
          undefined,
          { labeled: false },
        );
        expect(rows).toEqual([{ c: 2 }]);
      });

      it("returns another read while a long one runs", async () => {
        pool = new ReadWorkerPool({ maxWorkers: 2 });
        const cancel = new AbortController();
        const long = pool.query(path, LONG_READ, undefined, {
          labeled: false,
          signal: cancel.signal,
        });
        const longSettled = settledFlag(long);
        const { rows } = await pool.query(
          path,
          "SELECT k FROM t ORDER BY k",
          undefined,
          { labeled: false },
        );
        expect(rows).toEqual([{ k: "a" }, { k: "b" }]);
        expect(longSettled()).toBe(false);
        cancel.abort();
        await rejectionOf(long);
      });

      it("rejects with an `AbortError` interrupting a running read its signal cancels", async () => {
        pool = new ReadWorkerPool({ maxWorkers: 1 });
        // Once a read has returned, the pool's one worker is idle, so the long
        // read below goes to it at once rather than waiting in the queue.
        await pool.query(path, "SELECT 1", undefined, { labeled: false });
        const cancel = new AbortController();
        const long = pool.query(path, LONG_READ, undefined, {
          labeled: false,
          signal: cancel.signal,
        });
        cancel.abort(new Error("the caller left"));
        const error = await rejectionOf(long);
        expect(error.name).toBe("AbortError");
        expect(error.message).toContain("the caller left");
        expect(causeMessage(error)).toMatch(/interrupted$/);
      });

      it("rejects with an `AbortError` dropping a queued read its signal cancels", async () => {
        pool = new ReadWorkerPool({ maxWorkers: 1 });
        const running = new AbortController();
        const long = pool.query(path, LONG_READ, undefined, {
          labeled: false,
          signal: running.signal,
        });
        const longSettled = settledFlag(long);
        const queued = new AbortController();
        const waiting = pool.query(path, "SELECT 1", undefined, {
          labeled: false,
          signal: queued.signal,
        });
        queued.abort();
        const error = await rejectionOf(waiting);
        expect(error.name).toBe("AbortError");
        expect(causeMessage(error)).toBeUndefined();
        expect(longSettled()).toBe(false);
        running.abort();
        await rejectionOf(long);
      });

      it("rejects with an `AbortError` given a signal already cancelled", async () => {
        pool = new ReadWorkerPool();
        const error = await rejectionOf(
          pool.query(path, "SELECT 1", undefined, {
            labeled: false,
            signal: AbortSignal.abort(),
          }),
        );
        expect(error.name).toBe("AbortError");
      });

      it("rejects the reads waiting for a worker that cannot start", async () => {
        // A regression that starts another worker for the waiting read keeps
        // starting them, and this case never settles.

        pool = new ReadWorkerPool({
          workerModule: new URL(
            "./support/no-such-read-worker.ts",
            import.meta.url,
          ),
        });
        const error = await rejectionOf(
          pool.query(path, "SELECT 1", undefined, { labeled: false }),
        );
        expect(error.message).toContain("a read worker failed");
      });

      it("rejects a read whose worker dies running it", async () => {
        pool = new ReadWorkerPool({
          workerModule: new URL(
            "./support/read-worker-crash.ts",
            import.meta.url,
          ),
        });
        const error = await rejectionOf(
          pool.query(path, "SELECT 1", undefined, { labeled: false }),
        );
        expect(error.message).toContain("the read worker crashed");
      });

      it("returns the next read on a worker whose read was interrupted", async () => {
        pool = new ReadWorkerPool({ maxWorkers: 1 });
        await pool.query(path, "SELECT 1", undefined, { labeled: false });
        const cancel = new AbortController();
        const long = pool.query(path, LONG_READ, undefined, {
          labeled: false,
          signal: cancel.signal,
        });
        cancel.abort();
        await rejectionOf(long);
        const { rows } = await pool.query(
          path,
          "SELECT count(*) AS c FROM t",
          undefined,
          { labeled: false },
        );
        expect(rows).toEqual([{ c: 2 }]);
      });
    });

    describe("close()", () => {
      it("interrupts a running read, and settles once it has", async () => {
        pool = new ReadWorkerPool({ maxWorkers: 1 });
        await pool.query(path, "SELECT 1", undefined, { labeled: false });
        const long = pool.query(path, LONG_READ, undefined, {
          labeled: false,
        });
        const longSettled = settledFlag(long);
        await pool.close();
        expect(longSettled()).toBe(true);
        const error = await rejectionOf(long);
        expect(error.message).toContain("the read pool closed");
        expect(causeMessage(error)).toMatch(/interrupted$/);
      });

      it("rejects a read asked for after it", async () => {
        pool = new ReadWorkerPool();
        await pool.close();
        await expect(
          pool.query(path, "SELECT 1", undefined, { labeled: false }),
        ).rejects.toThrow("the read pool is closed");
      });
    });
  });
});

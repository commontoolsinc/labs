// Phase 0 wiring smoke test: the SQLite builtins are registered and reachable
// end to end through the builder -> module registry -> result cells. Server-side
// execution is not wired yet, so query/execute resolve to a structured
// not-implemented error (asserted here so the wiring — not fabricated results —
// is what's tested).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { createCell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  type DataUnavailable,
  DataUnavailable as DataUnavailableValue,
  isDataUnavailable,
} from "@commonfabric/data-model/fabric-instances";
import { sqliteQueryStateNodeFactory } from "../src/builtins/sqlite/query-node.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("sqlite builtins (Phase 0 wiring)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("table()/cfLink() are exposed and produce schemas", () => {
    const t = cf.table({
      id: "integer primary key",
      author_cf_link: cf.cfLink(),
    });
    expect((t as { type: string }).type).toBe("object");
    expect(cf.cfLink()).toEqual({
      type: "string",
      cfLink: true,
      sqlType: "text",
    });
  });

  it("reads through the query builtin (full builder->server->engine path)", async () => {
    // Deterministic single-effect read: a fresh db's declared table is created
    // server-side (ensureTables) and the query returns an empty result. Writes
    // are the imperative SqliteDb.exec (folded into the caller's commit; see
    // sqlite-db-exec.test.ts / sqlite-commit-fold.test.ts); read-after-write
    // reactivity within a pattern is intentionally not auto-driven.
    const queryPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      return cf.sqliteQuery({ db, sql: "SELECT body FROM notes", reactOn: db });
    });
    const resultCell = runtime.getCell(
      space,
      "sqlite-query-real",
      queryPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, queryPattern, {}, resultCell);
    tx.commit();

    const q = await waitUntil<QueryValue>(
      runtime,
      result,
      (v) => !isDataUnavailable(v),
    );
    expect(q).toEqual({ rows: [] });
  });

  it("settled() waits for an in-flight reactive query flush (no stale read)", async () => {
    // Regression for the lunch-poll CI flake (assertions read a sqlite query
    // result before it settled under load). A reactive `sqliteQuery` issues its
    // server read from a POST-COMMIT outbox flush (an async RPC + result
    // writeback). `idle()` deliberately returns before that I/O, so a reader
    // must use `runtime.settled()` — which waits for the in-flight async builtin
    // work — to observe a settled result rather than `{ pending: true }`.
    //
    // We make the server read unmistakably slow so the flush is guaranteed
    // in-flight. `idle()` alone resolves against the half-settled
    // `{ pending: true }` state; `settled()` stays open until the flush writes
    // the result back.
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = async (...a) => {
      await new Promise((r) => setTimeout(r, 50));
      return await original(...a);
    };
    try {
      const queryPattern = cf.pattern(() => {
        const db = cf.sqliteDatabase({
          tables: {
            notes: cf.table({ id: "integer primary key", body: "text" }),
          },
        });
        return cf.sqliteQuery({
          db,
          sql: "SELECT body FROM notes",
          reactOn: db,
        });
      });
      const resultCell = runtime.getCell(
        space,
        "sqlite-settled",
        queryPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, queryPattern, {}, resultCell);
      await tx.commit();

      // Observe the result so the effect runs in pull mode. `idle()` returns
      // before the latency-bounded flush completes (still pending); `settled()`
      // waits for it.
      const view = result as unknown as {
        get: () => QueryValue;
        resolveAsCell: () => { getRaw: () => QueryValue };
        sink: (f: () => void) => () => void;
      };
      const cancel = view.sink(() => {});
      try {
        await runtime.idle();
        const pending = view.resolveAsCell().getRaw();
        expect(isDataUnavailable(pending) && pending.reason === "pending").toBe(
          true,
        );

        await runtime.settled();
        const v = view.get();
        expect(v).toEqual({ rows: [] });
      } finally {
        cancel();
      }
    } finally {
      provider.sqliteQuery = original;
    }
  });

  // The db's on-disk file is the server's job; what the *runner* must get right
  // is forwarding the author-declared scope to the wire. `.asScope("user")` is
  // what the transformer lowers `const db: PerUser<SqliteDb> = sqliteDatabase()`
  // into; it sets the node default scope, which the runner folds into the output
  // binding and the builtin stamps onto the SqliteDbRef. We spy on the storage
  // provider to capture the ref `db.query` actually sends.
  async function capturedQueryScope(
    // deno-lint-ignore no-explicit-any
    makeDb: () => any,
    label: string,
  ): Promise<unknown> {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (db: { scope?: unknown }, ...rest: unknown[]) => unknown;
    };
    const original = provider.sqliteQuery.bind(provider);
    let seenScope: unknown = "<<unset>>";
    provider.sqliteQuery = (db, ...rest) => {
      seenScope = db?.scope;
      return original(db, ...rest);
    };
    try {
      const queryPattern = cf.pattern(() => {
        const db = makeDb();
        return cf.sqliteQuery({
          db,
          sql: "SELECT body FROM notes",
          reactOn: db,
        });
      });
      const resultCell = runtime.getCell(
        space,
        label,
        queryPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, queryPattern, {}, resultCell);
      tx.commit();
      await waitUntil<QueryState>(
        runtime,
        result,
        () => seenScope !== "<<unset>>",
      );
      return seenScope;
    } finally {
      provider.sqliteQuery = original;
    }
  }

  const tables = () => ({
    tables: { notes: cf.table({ id: "integer primary key", body: "text" }) },
  });

  it("forwards a user-scoped db (.asScope) to the query wire", async () => {
    expect(
      await capturedQueryScope(
        () => cf.sqliteDatabase.asScope("user")(tables()),
        "sqlite-scope-user",
      ),
    ).toBe("user");
  });

  it("forwards space scope for an unscoped db", async () => {
    expect(
      await capturedQueryScope(
        () => cf.sqliteDatabase(tables()),
        "sqlite-scope-default",
      ),
    ).toBe("space");
  });

  // Drive a query to its terminal state through `settled()` and read the result
  // cell — the event-driven wait, with no sleep or polling loop. `settled()`
  // stays open until the post-commit flush writes the result (or error) back, so
  // the write-back handlers run every time rather than depending on whether the
  // async flush lands inside the observation window.
  async function runQueryToSettled(
    sql: string,
    label: string,
    extra: Record<string, unknown> = {},
  ) {
    const queryPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      return cf.sqliteQuery({ db, sql, reactOn: db, ...extra });
    });
    const resultCell = runtime.getCell(
      space,
      label,
      queryPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, queryPattern, {}, resultCell);
    await tx.commit();

    const view = result as unknown as {
      get: () => QueryValue;
      resolveAsCell: () => { getRaw: () => QueryValue };
      sink: (f: () => void) => () => void;
    };
    const cancel = view.sink(() => {});
    try {
      await runtime.idle();
      await runtime.settled();
      const raw = view.resolveAsCell().getRaw();
      return isDataUnavailable(raw) ? raw : view.get();
    } finally {
      cancel();
    }
  }

  it("writes a successful query result back through the post-commit flush", async () => {
    const q = await runQueryToSettled(
      "SELECT body FROM notes",
      "sqlite-success-writeback",
    );
    expect(q).toEqual({ rows: [] });
  });

  it("writes an error result when the sqlite read fails, rather than staying pending", async () => {
    // Force the server read to fail. The builtin must surface that as a settled
    // error result on the query cell, not leave the query pending forever.
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = () =>
      Promise.reject(new Error("sqlite backend unavailable"));
    try {
      const q = await runQueryToSettled(
        "SELECT body FROM notes",
        "sqlite-error-writeback",
      );
      expect(isDataUnavailable(q) && q.reason === "error").toBe(true);
      if (isDataUnavailable(q) && q.reason === "error") {
        expect(q.error.message).toContain("sqlite backend unavailable");
      }
    } finally {
      provider.sqliteQuery = original;
    }
  });

  it("publishes schema mismatch for a typed row violation", async () => {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = () => Promise.resolve({ rows: [{ id: "wrong" }] });
    try {
      const q = await runQueryToSettled(
        "SELECT id FROM notes",
        "sqlite-row-schema-mismatch",
        {
          rowSchema: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
          },
        },
      );
      expect(isDataUnavailable(q) && q.reason === "schema-mismatch").toBe(
        true,
      );
    } finally {
      provider.sqliteQuery = original;
    }
  });

  it("propagates unavailable query inputs without issuing a read", async () => {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    let calls = 0;
    provider.sqliteQuery = (...args) => {
      calls++;
      return original(...args);
    };
    try {
      const pending = DataUnavailableValue.pending();
      const queryPattern = cf.pattern(() =>
        cf.sqliteQuery({
          // deno-lint-ignore no-explicit-any
          db: pending as any,
          sql: "SELECT 1",
        })
      );
      const resultCell = runtime.getCell(
        space,
        "sqlite-unavailable-input",
        queryPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, queryPattern, {}, resultCell);
      await tx.commit();
      await runtime.idle();

      expect(result.resolveAsCell().getRaw()).toEqual(pending);
      expect(calls).toBe(0);
    } finally {
      provider.sqliteQuery = original;
    }
  });

  // Issue a query and hold its server read in flight on `gate` (a Promise the
  // test resolves by hand — no sleep or timer). While it is held, a write bumps
  // the db revision, so the query re-issues with a new request hash: a genuine
  // supersede. When the held read finally finishes, its flush must notice the
  // hash changed and leave the newer query's state alone.
  async function runStaleFlush(
    outcome: "resolve" | "reject",
    label: string,
  ): Promise<{ q: QueryState; secondHash: string }> {
    const provider = runtime.storageManager.open(space) as unknown as {
      sqliteQuery: (...a: unknown[]) => Promise<unknown>;
    };
    const original = provider.sqliteQuery.bind(provider);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.sqliteQuery = async (...a) => {
      await gate;
      if (outcome === "reject") throw new Error("sqlite read failed late");
      return await original(...a);
    };
    try {
      const pattern = cf.pattern(() => {
        const db = cf.sqliteDatabase({
          tables: {
            notes: cf.table({ id: "integer primary key", body: "text" }),
          },
        });
        const q = sqliteQueryStateNodeFactory({
          db,
          sql: "SELECT body FROM notes",
          reactOn: db,
        });
        return { db, q };
      });
      const resultCell = runtime.getCell(space, label, undefined, tx);
      runtime.run(tx, pattern, {}, resultCell);
      await tx.commit();

      const qCell = resultCell.key("q").resolveAsCell() as unknown as {
        get: () => QueryState;
        sink: (f: () => void) => () => void;
      };
      const cancel = qCell.sink(() => {});
      try {
        // The first query is issued; its server read now waits on the gate.
        await runtime.idle();
        const firstHash = qCell.get().requestHash;
        expect(typeof firstHash).toBe("string");
        expect(qCell.get().pending).toBe(true);

        // A write bumps the db revision, re-issuing the query with a new hash
        // while the first read is still held.
        const execTx = runtime.edit();
        const handleLink = resultCell.key("db").resolveAsCell()
          .getAsNormalizedFullLink();
        const db = createCell(
          runtime,
          { ...handleLink, schema: undefined },
          execTx,
          false,
          "sqlite",
        ) as unknown as {
          exec(sql: string, params?: readonly unknown[]): void;
        };
        db.exec("INSERT INTO notes (body) VALUES (?)", ["seed"]);
        expect((await execTx.commit()).error).toBeUndefined();
        await runtime.idle();
        const secondHash = qCell.get().requestHash;
        expect(secondHash).not.toBe(firstHash);
        expect(typeof secondHash).toBe("string");

        // Release both reads. The first (now stale) flush must find the hash
        // changed and skip its write-back.
        release();
        await runtime.settled();
        return { q: qCell.get(), secondHash: secondHash! };
      } finally {
        cancel();
      }
    } finally {
      provider.sqliteQuery = original;
    }
  }

  it("a superseded query's successful flush does not overwrite the newer request", async () => {
    const { q, secondHash } = await runStaleFlush("resolve", "sqlite-stale-ok");
    // Only the newer query settled its own result; the stale flush was skipped.
    expect(q.requestHash).toBe(secondHash);
    expect(q.pending).toBe(false);
    expect(q.error).toBeUndefined();
  });

  it("a superseded query's failed flush does not overwrite the newer request", async () => {
    const { q, secondHash } = await runStaleFlush("reject", "sqlite-stale-err");
    // Both reads reject, but only the newer query's error survives — the stale
    // flush's error write is skipped.
    expect(q.requestHash).toBe(secondHash);
    expect(q.pending).toBe(false);
    expect(q.error).toBeDefined();
  });
});

type QueryState = {
  pending: boolean;
  result?: unknown[];
  error?: unknown;
  requestHash?: string;
};

type QueryValue =
  | { rows: unknown[]; withheld?: number }
  | DataUnavailable;

// Wait until `pred(cell value)` holds. A `sink` keeps the effect chain live so
// reactOn re-runs are driven (pull-mode runs effects only while observed); the
// loop is fully awaited and the sink is cancelled in `finally`, so nothing runs
// after the test disposes the engine (avoids an FFI-after-dispose segfault).
// deno-lint-ignore no-explicit-any
async function waitUntil<T>(
  runtime: Runtime,
  cell: any,
  pred: (v: T) => boolean,
  iterations = 400,
): Promise<T> {
  const cancel = cell.sink(() => {}) as () => void;
  try {
    for (let i = 0; i < iterations; i++) {
      await runtime.idle();
      const v = cell.get() as T;
      if (pred(v)) return v;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("timeout waiting for sqlite result");
  } finally {
    cancel?.();
  }
}

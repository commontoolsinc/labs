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
import type {
  IExtendedStorageTransaction,
  IStorageProviderWithReplica,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type SqliteQueryProvider = IStorageProviderWithReplica & {
  sqliteQuery: NonNullable<IStorageProviderWithReplica["sqliteQuery"]>;
};

function assertSqliteQueryProvider(
  provider: IStorageProviderWithReplica,
): asserts provider is SqliteQueryProvider {
  if (typeof provider.sqliteQuery !== "function") {
    throw new Error("Expected sqliteQuery provider");
  }
}

function sqliteQueryProvider(runtime: Runtime): SqliteQueryProvider {
  const provider = runtime.storageManager.open(space);
  assertSqliteQueryProvider(provider);
  return provider;
}

function expectQueryState(value: unknown): QueryState {
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { pending?: unknown }).pending !== "boolean"
  ) {
    throw new Error("Expected query state");
  }
  return value as QueryState;
}

function queryResultView(value: unknown): {
  get: () => QueryState;
  sink: (f: () => void) => () => void;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected query result view");
  }
  const get = Reflect.get(value, "get");
  const sink = Reflect.get(value, "sink");
  if (typeof get !== "function" || typeof sink !== "function") {
    throw new Error("Expected query result view methods");
  }
  return {
    get: () => expectQueryState(Reflect.apply(get, value, [])),
    sink: (f) => {
      const cancel = Reflect.apply(sink, value, [f]);
      if (typeof cancel !== "function") {
        throw new Error("Expected query result sink cancellation");
      }
      return () => {
        Reflect.apply(cancel, undefined, []);
      };
    },
  };
}

function sqliteExecView(value: unknown): {
  exec(sql: string, params?: readonly unknown[]): void;
} {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    throw new Error("Expected sqlite exec cell");
  }
  const exec = Reflect.get(value, "exec");
  if (typeof exec !== "function") {
    throw new Error("Expected sqlite exec method");
  }
  return {
    exec: (sql, params) => {
      Reflect.apply(exec, value, [sql, params]);
    },
  };
}

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

    const q = await waitUntil<QueryState>(
      runtime,
      result,
      (v) => v.pending === false,
    );
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([]);
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
    const provider = sqliteQueryProvider(runtime);
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
      const view = queryResultView(result);
      const cancel = view.sink(() => {});
      try {
        await runtime.idle();
        expect(view.get().pending).toBe(true);

        await runtime.settled();
        const v = view.get();
        expect(v.pending).toBe(false);
        expect(v.error).toBeUndefined();
        expect(v.result).toEqual([]);
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
    const provider = sqliteQueryProvider(runtime);
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
  async function runQueryToSettled(sql: string, label: string) {
    const queryPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      return cf.sqliteQuery({ db, sql, reactOn: db });
    });
    const resultCell = runtime.getCell(
      space,
      label,
      queryPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, queryPattern, {}, resultCell);
    await tx.commit();

    const view = queryResultView(result);
    const cancel = view.sink(() => {});
    try {
      await runtime.idle();
      await runtime.settled();
      return view.get();
    } finally {
      cancel();
    }
  }

  it("writes a successful query result back through the post-commit flush", async () => {
    const q = await runQueryToSettled(
      "SELECT body FROM notes",
      "sqlite-success-writeback",
    );
    expect(q.pending).toBe(false);
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([]);
  });

  it("writes an error result when the sqlite read fails, rather than staying pending", async () => {
    // Force the server read to fail. The builtin must surface that as a settled
    // error result on the query cell, not leave the query pending forever.
    const provider = sqliteQueryProvider(runtime);
    const original = provider.sqliteQuery.bind(provider);
    provider.sqliteQuery = () =>
      Promise.reject(new Error("sqlite backend unavailable"));
    try {
      const q = await runQueryToSettled(
        "SELECT body FROM notes",
        "sqlite-error-writeback",
      );
      expect(q.pending).toBe(false);
      expect(q.error).toBeDefined();
      expect(q.result).toBeUndefined();
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
    const provider = sqliteQueryProvider(runtime);
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
        const q = cf.sqliteQuery({
          db,
          sql: "SELECT body FROM notes",
          reactOn: db,
        });
        return { db, q };
      });
      const resultCell = runtime.getCell(space, label, undefined, tx);
      runtime.run(tx, pattern, {}, resultCell);
      await tx.commit();

      const qCell = queryResultView(resultCell.key("q").resolveAsCell());
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
        const db = sqliteExecView(
          createCell(
            runtime,
            { ...handleLink, schema: undefined },
            execTx,
            false,
            "sqlite",
          ),
        );
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

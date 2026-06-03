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
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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

    const q = await waitUntil<QueryState>(
      runtime,
      result,
      (v) => v.pending === false,
    );
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([]);
  });
});

type QueryState = { pending: boolean; result?: unknown[]; error?: unknown };

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

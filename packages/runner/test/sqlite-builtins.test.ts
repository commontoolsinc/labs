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

  it("executes a write through the builtin against the emulated server", async () => {
    const execPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      return cf.sqliteExecute({
        db,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["hi"],
      });
    });
    const resultCell = runtime.getCell(
      space,
      "sqlite-exec-real",
      execPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, execPattern, {}, resultCell);
    tx.commit();

    const e = await waitUntil<ExecState>(
      runtime,
      () => result.get() as ExecState,
      (v) => v.pending === false,
    );
    expect(e.error).toBeUndefined();
    expect(e.result?.changes).toBe(1);
  });

  it("reads through the query builtin (full builder->server->engine path)", async () => {
    // Deterministic single-effect read: a fresh db's declared table is created
    // server-side (ensureTables) and the query returns an empty result. Reading
    // non-empty data written by a *sibling* sqliteExecute in the same pattern
    // depends on cross-effect reactОn sequencing, which is proven at the storage
    // (sqlite-storage.test) and protocol (v2-sqlite-protocol-test) layers;
    // builtin-level reactive re-query is tracked in IMPLEMENTATION_LOG.
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
      () => result.get() as QueryState,
      (v) => v.pending === false,
    );
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([]);
  });

  it("re-runs a reactOn:db query after a write (reactive loop)", async () => {
    const p = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      });
      const q = cf.sqliteQuery({
        db,
        sql: "SELECT body FROM notes ORDER BY id",
        reactOn: db, // re-run when the db handle's rev bumps (post-write)
      });
      cf.sqliteExecute({
        db,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["reactive"],
      });
      return q;
    });
    const resultCell = runtime.getCell(
      space,
      "sqlite-reactive",
      p.resultSchema,
      tx,
    );
    const result = runtime.run(tx, p, {}, resultCell);
    tx.commit();

    // Initial query is empty; after the write commits it bumps db.rev, which
    // re-runs the reactOn:db query and the row appears.
    const q = await waitUntil<QueryState>(
      runtime,
      () => result.get() as QueryState,
      (v) =>
        v.pending === false && Array.isArray(v.result) && v.result.length === 1,
    );
    expect(q.error).toBeUndefined();
    expect(q.result).toEqual([{ body: "reactive" }]);
  });
});

type ExecState = {
  pending: boolean;
  result?: { changes: number; lastInsertRowid?: number };
  error?: unknown;
};
type QueryState = { pending: boolean; result?: unknown[]; error?: unknown };

// Pump the runtime (idle) and poll the result cell until `pred` holds. This
// drives the post-commit async flush + any reactOn re-runs to completion.
async function waitUntil<T>(
  runtime: Runtime,
  read: () => T,
  pred: (v: T) => boolean,
  iterations = 100,
): Promise<T> {
  for (let i = 0; i < iterations; i++) {
    await runtime.idle();
    const v = read();
    if (pred(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout waiting for sqlite result");
}

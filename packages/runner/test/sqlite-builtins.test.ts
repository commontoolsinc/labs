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

  it("wires sqliteQuery through to a result cell (server exec pending)", async () => {
    const queryPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: { t: cf.table({ id: "integer" }) },
      });
      return cf.sqliteQuery({ db, sql: "SELECT id FROM t", reactOn: db });
    });
    const resultCell = runtime.getCell(
      space,
      "sqlite-query-wiring",
      queryPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, queryPattern, {}, resultCell);
    tx.commit();
    await runtime.idle();

    const q = result.get() as { pending: boolean; error?: unknown };
    expect(q.pending).toBe(false);
    expect(typeof q.error).toBe("string"); // not-implemented marker, not a fabricated result
  });

  it("wires sqliteExecute through to a result cell (commit-folded exec pending)", async () => {
    const execPattern = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: { t: cf.table({ id: "integer" }) },
      });
      return cf.sqliteExecute({ db, sql: "INSERT INTO t (id) VALUES (1)" });
    });
    const resultCell = runtime.getCell(
      space,
      "sqlite-exec-wiring",
      execPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, execPattern, {}, resultCell);
    tx.commit();
    await runtime.idle();

    const e = result.get() as { pending: boolean; error?: unknown };
    expect(e.pending).toBe(false);
    expect(typeof e.error).toBe("string");
  });
});

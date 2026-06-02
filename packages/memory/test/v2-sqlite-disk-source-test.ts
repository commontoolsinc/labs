// Phase 7 — injected on-disk SQLite source (read-only v1).
//
// Two seams proven here without the websocket:
//   1. read-only ATTACH: a seeded on-disk file is attached read-only; SELECT
//      returns its rows, but any write to the alias is rejected at the engine.
//   2. DiskSourceRegistry: register/get a `{ disk: { path } }` descriptor keyed
//      by the handle cell id.
//
// Spec: docs/specs/sqlite-builtin/03-database-sources.md §03.3; plan
// docs/specs/sqlite-builtin/plans/on-disk-source.md. Writes/reactivity for
// on-disk sources are deferred (Q12/Q13/Q14).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import {
  attachDatabase,
  detachDatabase,
  runQuery,
  setQueryOnly,
} from "../v2/sqlite/exec.ts";
import { DiskSourceRegistry } from "../v2/sqlite/disk-source.ts";

function seedDiskDb(path: string): void {
  const seed = new Database(path);
  seed.exec("CREATE TABLE lookup (k TEXT, v TEXT)");
  seed.exec("INSERT INTO lookup (k, v) VALUES ('a', '1'), ('b', '2')");
  seed.close();
}

describe("read-only attach of an on-disk file", () => {
  let db: Database;
  let path: string;

  beforeEach(() => {
    db = new Database(":memory:");
    path = Deno.makeTempFileSync({ suffix: ".sqlite" });
    seedDiskDb(path);
  });

  afterEach(() => {
    db.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  });

  it("reads rows from the on-disk file", () => {
    attachDatabase(db, "disk_src", path, { readOnly: true });
    setQueryOnly(db, true);
    try {
      const rows = runQuery<{ v: string }>(
        db,
        "SELECT v FROM lookup ORDER BY k",
      );
      expect(rows).toEqual([{ v: "1" }, { v: "2" }]);
    } finally {
      setQueryOnly(db, false);
      detachDatabase(db, "disk_src");
    }
  });

  it("rejects a write to the read-only attached file", () => {
    attachDatabase(db, "disk_src", path, { readOnly: true });
    setQueryOnly(db, true);
    try {
      expect(() =>
        db.prepare("INSERT INTO lookup (k, v) VALUES ('c', '3')").run()
      ).toThrow();
    } finally {
      setQueryOnly(db, false);
      detachDatabase(db, "disk_src");
    }
  });
});

describe("DiskSourceRegistry", () => {
  it("registers and resolves a disk descriptor by handle id", () => {
    const reg = new DiskSourceRegistry();
    expect(reg.get("of:bafy123")).toBeUndefined();
    reg.register("of:bafy123", { path: "/abs/reference-data.db" });
    expect(reg.get("of:bafy123")).toEqual({ path: "/abs/reference-data.db" });
  });

  it("reports whether an id is a registered disk source", () => {
    const reg = new DiskSourceRegistry();
    expect(reg.has("of:x")).toBe(false);
    reg.register("of:x", { path: "/abs/x.db" });
    expect(reg.has("of:x")).toBe(true);
  });
});

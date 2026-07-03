// SqliteDb `.exec` — the sync, commit-folded write method on a "sqlite"-kind
// cell. Tested by minting a "sqlite"-kind cell directly (the ergonomic
// pattern->handler path, where the transformer lowers SqliteDb to asCell:
// ["sqlite"], is integration-level). Proves: exec folds into the cell's tx
// atomically with sibling cell writes; throws on undefined params (null ok);
// encodes _cf_link cell params; SQL failure aborts the whole commit.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import { createCell } from "../src/cell.ts";
import { decodeCfLinkValue } from "../src/builtins/sqlite/cf-link.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

type SqliteDbCell = {
  exec(
    sql: string,
    params?: ReadonlyArray<unknown> | Record<string, unknown>,
  ): void;
  get(): unknown;
};

describe("SqliteDb .exec (commit-folded write)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let signer: Identity;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`dbexec-${crypto.randomUUID()}`);
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Mint a "sqlite"-kind cell whose value is the db handle ref.
  function sqliteDb(
    dbRef: SqliteDbRef,
    tx: IExtendedStorageTransaction,
    label: string,
  ): SqliteDbCell {
    const handle = runtime.getCell(space, label, undefined, tx);
    handle.set(dbRef);
    return createCell(
      runtime,
      handle.getAsNormalizedFullLink(),
      tx,
      false,
      "sqlite",
    ) as unknown as SqliteDbCell;
  }

  it("folds a write atomically with a sibling cell write", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    const marker = runtime.getCell<{ ok: boolean }>(
      space,
      "exec-marker",
      undefined,
      tx,
    );
    marker.set({ ok: true });
    db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(dbRef, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "hi" }]);

    const tx2 = runtime.edit();
    expect(
      runtime.getCell<{ ok: boolean }>(space, "exec-marker", undefined, tx2)
        .withTx(tx2).get(),
    ).toEqual({ ok: true });
    await tx2.commit();
  });

  it("reads the handle via getRaw even when the cell schema shapes it to {}", async () => {
    // Real handler-input materialization delivers the handle cell with the
    // `SqliteDatabase` schema (an object type with NO declared properties). A
    // schema-shaped `get()` would project the handle down to `{}` and drop
    // `id`/`tables`; `.exec` must read the raw handle (getRaw, lastNode:"value")
    // and still fold the write. Regression guard for the get()->getRaw() fix.
    const dbRef: SqliteDbRef = {
      id: `of:exec-shaped-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const handle = runtime.getCell(space, "db-shaped", undefined, tx);
    handle.set(dbRef);
    const db = createCell(
      runtime,
      {
        ...handle.getAsNormalizedFullLink(),
        schema: { type: "object", properties: {} },
      },
      tx,
      false,
      "sqlite",
    ) as unknown as SqliteDbCell;
    // Sanity: a schema-shaped read drops the handle fields...
    expect(db.get()).toEqual({});
    // ...but exec still records the write from the raw handle.
    db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(dbRef, "SELECT body FROM notes");
    expect(r.rows).toEqual([{ body: "hi" }]);
  });

  it("throws on an undefined param, allows null", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-undef-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    expect(() => db.exec("INSERT INTO notes (body) VALUES (?)", [undefined]))
      .toThrow();
    // null is allowed (SQL NULL).
    db.exec("INSERT INTO notes (body) VALUES (?)", [null]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      dbRef,
      "SELECT count(*) AS c FROM notes",
    );
    expect((r.rows[0] as { c: number }).c).toBe(1);
  });

  it("accepts named params", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-named-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    db.exec("INSERT INTO notes (body) VALUES (:body)", { body: "hi" });
    const res = await tx.commit();
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      dbRef,
      "SELECT body FROM notes",
    );
    expect(r.rows).toEqual([{ body: "hi" }]);
  });

  it("encodes a _cf_link cell param (round-trips to the same entity)", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-link-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    const tx = runtime.edit();
    const author = runtime.getCell<{ name: string }>(
      space,
      "author",
      undefined,
      tx,
    );
    author.set({ name: "Ada" });
    const db = sqliteDb(dbRef, tx, "db-h");
    db.exec("INSERT INTO people (author_cf_link) VALUES (?)", [author]);
    const res = await tx.commit();
    expect(res.error).toBeUndefined();

    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      dbRef,
      "SELECT author_cf_link FROM people",
    );
    const stored = (r.rows[0] as { author_cf_link: string }).author_cf_link;
    expect(typeof stored).toBe("string");
    const tx2 = runtime.edit();
    const decoded = decodeCfLinkValue(stored, runtime, undefined, tx2);
    expect(decoded).not.toBeNull();
    expect(
      areNormalizedLinksSame(
        decoded!.getAsNormalizedFullLink(),
        author.getAsNormalizedFullLink(),
      ),
    ).toBe(true);
    await tx2.commit();
  });

  it("encodes link cells across a multi-row INSERT (cols cycle per tuple)", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-multi-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    const tx = runtime.edit();
    const a = runtime.getCell<{ n: string }>(space, "a", undefined, tx);
    a.set({ n: "A" });
    const b = runtime.getCell<{ n: string }>(space, "b", undefined, tx);
    b.set({ n: "B" });
    const db = sqliteDb(dbRef, tx, "db-h");
    // Both positional cells target author_cf_link; the second tuple must reuse
    // the parsed column list (previously cols[1] was undefined -> wrongly threw).
    db.exec(
      "INSERT INTO people (author_cf_link) VALUES (?), (?)",
      [a, b],
    );
    const res = await tx.commit();
    expect(res.error).toBeUndefined();
    const provider = storageManager.open(space);
    const r = await provider.sqliteQuery!(
      dbRef,
      "SELECT count(*) AS c FROM people",
    );
    expect((r.rows[0] as { c: number }).c).toBe(2);
  });

  it("rejects a Cell bound where the target column can't be verified", () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-unverif-${crypto.randomUUID()}`,
      tables: {
        notes: table({ id: "integer primary key", body: "text" }),
      },
    };
    const tx = runtime.edit();
    const cell = runtime.getCell<{ n: string }>(space, "c", undefined, tx);
    cell.set({ n: "x" });
    const db = sqliteDb(dbRef, tx, "db-h");
    // UPDATE has no explicit column list, so a Cell's target column is unknown.
    // Previously this silently sigil-encoded the cell into the plain `body`
    // column (corruption); now it throws an actionable error.
    expect(() => db.exec("UPDATE notes SET body = ? WHERE id = ?", [cell, 1]))
      .toThrow("target column can't be determined");
    // Columnless INSERT likewise can't verify the column for a Cell.
    expect(() => db.exec("INSERT INTO notes VALUES (?, ?)", [1, cell])).toThrow(
      "target column can't be determined",
    );
    tx.abort();
  });

  it("allows non-cell positional params in columnless/UPDATE statements", () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-plain-${crypto.randomUUID()}`,
      tables: { notes: table({ id: "integer primary key", body: "text" }) },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    // Encoding runs synchronously at db.exec(); with no cell params, a columnless
    // INSERT and an UPDATE must NOT false-throw at the encode layer (the column
    // can't be resolved, but that only matters for Cell bindings).
    expect(() => db.exec("INSERT INTO notes VALUES (?, ?)", [1, "hi"])).not
      .toThrow();
    expect(() => db.exec("UPDATE notes SET body = ? WHERE id = ?", ["bye", 1]))
      .not.toThrow();
    tx.abort();
  });

  it(".exec is only available on a sqlite-kind cell", () => {
    const tx = runtime.edit();
    const plain = runtime.getCell<{ x: number }>(space, "plain", undefined, tx);
    plain.set({ x: 1 });
    // .exec is a runtime write that requires a "sqlite"-kind cell (a handler's
    // db input). (.query is a build-time node constructor like .map, so it has
    // no _kind guard — `this` is an opaque builder ref at pattern-build time.)
    expect(() =>
      (plain as unknown as SqliteDbCell).exec("INSERT INTO t VALUES (1)")
    ).toThrow("SqliteDb");
  });

  it("aborts the whole commit on SQL failure (sibling rolls back)", async () => {
    const dbRef: SqliteDbRef = {
      id: `of:exec-fail-${crypto.randomUUID()}`,
      tables: {
        notes: table({ id: "integer primary key", body: "text not null" }),
      },
    };
    const tx = runtime.edit();
    const db = sqliteDb(dbRef, tx, "db-h");
    const marker = runtime.getCell<{ touched: boolean }>(
      space,
      "fail-marker",
      undefined,
      tx,
    );
    marker.set({ touched: true });
    // null into a NOT NULL column -> fails inside applyCommit -> abort.
    db.exec("INSERT INTO notes (body) VALUES (?)", [null]);
    const res = await tx.commit();
    expect(res.error).toBeDefined();

    const tx2 = runtime.edit();
    expect(
      runtime.getCell<{ touched: boolean }>(
        space,
        "fail-marker",
        undefined,
        tx2,
      )
        .withTx(tx2).get(),
    ).toBeUndefined();
    await tx2.commit();
  });
});

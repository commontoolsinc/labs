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

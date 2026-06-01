// Phase M3-decode (RED → GREEN): a query result row surfaces a `*_cf_link`
// column as a LIVE Cell when read through the static (asCell-free) return-type
// schema a real consumer carries.
//
// This is the decisive test for plans/node-output-schema-propagation.md: the
// builtin writes its result cell with a per-query schema marking link columns
// `asCell`, and that schema must survive the node-output → consumer read path
// (where today the static builder return type shadows it). Encode-on-write is
// already proven (sqlite-cf-link-roundtrip.test.ts + the cf-link unit test); we
// seed the column with a pre-encoded sigil STRING so this test isolates the
// DECODE-on-read wiring, not the cell-as-param encode path.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { encodeCfLinkValue } from "../src/builtins/sqlite/cf-link.ts";

type QueryState = {
  pending: boolean;
  result?: Array<Record<string, unknown>>;
  error?: unknown;
};

// Wait until `pred(cell value)` holds; a sink keeps the effect chain live so
// reactOn re-runs are driven. Mirrors sqlite-builtins.test.ts.
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

describe("sqlite query result _cf_link decode (to live Cell)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  let signer: Identity;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    // Unique space per test => unique (space, db-id) => fresh cell-db temp file
    // (no row leakage across runs; see plans/reactivity.md).
    signer = await Identity.fromPassphrase(`decode-${crypto.randomUUID()}`);
    space = signer.did();
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

  it("reads q.result[0].author_cf_link as a live Cell resolving the target", async () => {
    // A committed target cell, encoded to an absolute sigil-link string.
    const author = runtime.getCell<{ name: string }>(space, "author", undefined, tx);
    author.set({ name: "Ada" });
    const encoded = encodeCfLinkValue(author);

    const p = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          people: cf.table({
            id: "integer primary key",
            author_cf_link: cf.cfLink(),
          }),
        },
      });
      const exec = cf.sqliteExecute({
        db,
        sql: "INSERT INTO people (author_cf_link) VALUES (?)",
        params: [encoded],
      });
      const q = cf.sqliteQuery({
        db,
        sql: "SELECT author_cf_link FROM people ORDER BY id",
        reactOn: db,
      });
      return { q, exec };
    });

    const resultCell = runtime.getCell(space, "decode-result", p.resultSchema, tx);
    const result = runtime.run(tx, p, {}, resultCell);
    tx.commit();

    const v = await waitUntil<{ q: QueryState }>(
      runtime,
      result,
      (s) =>
        s.q?.pending === false && Array.isArray(s.q?.result) &&
        s.q.result.length === 1,
    );
    expect(v.q.error).toBeUndefined();

    // The decisive assertion: read the link column through the consumer's
    // static schema and get a LIVE Cell, not the raw JSON string.
    const col = result.key("q").key("result").key(0).key("author_cf_link");
    const colValue = col.get();
    expect(isCell(colValue)).toBe(true);
    expect((colValue as { get(): unknown }).get()).toEqual({ name: "Ada" });
  });

  it("decodes a NULL link column to null", async () => {
    const p = cf.pattern(() => {
      const db = cf.sqliteDatabase({
        tables: {
          people: cf.table({
            id: "integer primary key",
            author_cf_link: cf.cfLink(),
          }),
        },
      });
      const exec = cf.sqliteExecute({
        db,
        sql: "INSERT INTO people (author_cf_link) VALUES (NULL)",
        params: [],
      });
      const q = cf.sqliteQuery({
        db,
        sql: "SELECT author_cf_link FROM people ORDER BY id",
        reactOn: db,
      });
      return { q, exec };
    });

    const resultCell = runtime.getCell(space, "decode-null", p.resultSchema, tx);
    const result = runtime.run(tx, p, {}, resultCell);
    tx.commit();

    const v = await waitUntil<{ q: QueryState }>(
      runtime,
      result,
      (s) =>
        s.q?.pending === false && Array.isArray(s.q?.result) &&
        s.q.result.length === 1,
    );
    expect(v.q.error).toBeUndefined();
    const col = result.key("q").key("result").key(0).key("author_cf_link");
    expect(col.get()).toBeNull();
  });
});

// `_cf_link` query-result behavior + the boundary of runtime decode-to-Cell.
//
// What a SELECT of a `*_cf_link` column returns today:
//   1. the stored value comes back as the sigil-link STRING (decodable on demand
//      via `decodeCfLinkValue`), and NULL comes back as null — both verified;
//   2. surfacing it AUTOMATICALLY as a live `Cell` (so `row.author_cf_link` is a
//      Cell with no per-read `asSchema`) is NOT yet wired at runtime — see the
//      skipped test below.
//
// Why automatic decode needs more than the transformer lowering (which now
// injects a `rowSchema` for `sqliteQuery<Row>` / `db.query<Row>`): the RUNTIME
// builtin must also read that `rowSchema`, store `*_cf_link` columns as sigil
// OBJECTS (not strings), and write the result through an asCell schema so the
// reader rehydrates them (Piece A, plans/result-decode-and-row-types.md +
// plans/node-output-schema-propagation.md). Encode-on-write round-trips already
// (sqlite-cf-link-roundtrip.test.ts).
//
// Writes here are seeded via the storage provider (the server `sqlite.execute`
// verb stays); pattern writes are the imperative `SqliteDb.exec` (sqlite-db-exec
// .test.ts), which is a folded commit, not a declarative builtin.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  decodeCfLinkValue,
  encodeCfLinkValue,
} from "../src/builtins/sqlite/cf-link.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";

describe("sqlite query result _cf_link behavior", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
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
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("returns the stored sigil-link string, decodable via decodeCfLinkValue", async () => {
    const author = runtime.getCell<{ name: string }>(
      space,
      "author",
      undefined,
      tx,
    );
    author.set({ name: "Ada" });
    const encoded = encodeCfLinkValue(author);

    const db: SqliteDbRef = {
      id: `of:decode-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    const provider = storageManager.open(space);
    await provider.sqliteExecute!(
      db,
      "INSERT INTO people (author_cf_link) VALUES (?)",
      [encoded],
    );

    const r = await provider.sqliteQuery!(
      db,
      "SELECT author_cf_link FROM people ORDER BY id",
    );
    expect(r.rows.length).toBe(1);
    const stored = (r.rows[0] as { author_cf_link: string }).author_cf_link;
    // Current behavior: the column is the stored sigil-link STRING.
    expect(typeof stored).toBe("string");
    // ...and it decodes to a live Cell pointing at the same entity.
    const decoded = decodeCfLinkValue(stored, runtime, undefined, tx);
    expect(decoded).not.toBeNull();
    expect(
      areNormalizedLinksSame(
        decoded!.getAsNormalizedFullLink(),
        author.getAsNormalizedFullLink(),
      ),
    ).toBe(true);
    expect(decoded!.get()).toEqual({ name: "Ada" });
  });

  it("returns a NULL link column as null", async () => {
    const db: SqliteDbRef = {
      id: `of:decode-null-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    const provider = storageManager.open(space);
    await provider.sqliteExecute!(
      db,
      "INSERT INTO people (author_cf_link) VALUES (NULL)",
    );
    const r = await provider.sqliteQuery!(
      db,
      "SELECT author_cf_link FROM people ORDER BY id",
    );
    expect(r.rows.length).toBe(1);
    expect((r.rows[0] as { author_cf_link: unknown }).author_cf_link)
      .toBeNull();
  });

  // BLOCKED: requires the Piece-A runtime wiring (builtin reads the injected
  // rowSchema, stores sigil objects, writes through an asCell schema) so a
  // typed `db.query<{ author_cf_link: Cell<...> }>` row surfaces a live Cell.
  // The transformer half (rowSchema injection) is done; the runtime half is not.
  it.skip("surfaces row.<col>_cf_link as a live Cell automatically", () => {
    // Target (unreachable until Piece A lands):
    //   const q = db.query<{ author_cf_link: Cell<{ name: string }> }>(sql);
    //   expect(isCell(q.result[0].author_cf_link)).toBe(true);
    expect(isCell).toBeDefined();
  });
});

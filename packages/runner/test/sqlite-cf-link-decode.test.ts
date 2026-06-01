// `_cf_link` query-result behavior + the boundary of runtime decode-to-Cell.
//
// Encode-on-write round-trips end to end (sqlite-cf-link-roundtrip.test.ts).
// This file pins what a *pattern* sees when it SELECTs a `*_cf_link` column:
//   1. the stored value comes back as the sigil-link STRING (decodable on demand
//      via `decodeCfLinkValue`), and NULL comes back as null — both verified;
//   2. surfacing it AUTOMATICALLY as a live `Cell` (so `q.result[i].author`
//      is a Cell with no per-read `asSchema`) is NOT achievable by the runtime
//      alone — see the skipped test below for the proof and the real fix.
//
// Why automatic decode can't be done at the runner layer (proven empirically in
// plans/node-output-schema-propagation.md):
//   - The result cell can carry a per-query schema marking link columns `asCell`,
//     and `resultForRawBuiltinOutputBinding` can emit a node-output link bearing
//     that schema (regular OR write-redirect).
//   - BUT runtime navigation derives a child's schema TOP-DOWN from the
//     CONSUMER's own schema. An untyped `sqliteQuery` lowers to an empty (`{}`)
//     consumer schema, so descending `q -> result -> [i] -> author_cf_link`
//     never carries `asCell`, and the deeper link schema is only honored when
//     the effective schema ALREADY `hasAsCell` (schema.ts:978 gate) — a
//     chicken-and-egg the node-output link can't break.
//   - Applying `.asSchema({... author_cf_link: {asCell}})` AT THE READING cell
//     does work — confirming the asCell markers must live on the CONSUMER's
//     schema. For an untyped query the call site cannot know which columns are
//     links, so this requires `sqliteQuery<Row>` with the transformer injecting
//     an `asCell`-bearing Row schema at the consumer (Piece B,
//     plans/result-decode-and-row-types.md §2). Piece B is therefore a
//     PREREQUISITE for auto-decode, not an independent nicety.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  decodeCfLinkValue,
  encodeCfLinkValue,
} from "../src/builtins/sqlite/cf-link.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";

type QueryState = {
  pending: boolean;
  result?: Array<Record<string, unknown>>;
  error?: unknown;
};

// Wait until `pred(cell value)` holds; a sink keeps the effect chain live so
// reactOn re-runs are driven (mirrors sqlite-builtins.test.ts).
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

describe("sqlite query result _cf_link behavior", () => {
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

  it("returns the stored sigil-link string, decodable via decodeCfLinkValue", async () => {
    const author = runtime.getCell<{ name: string }>(
      space,
      "author",
      undefined,
      tx,
    );
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

    const resultCell = runtime.getCell(
      space,
      "decode-result",
      p.resultSchema,
      tx,
    );
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

    // Current behavior: the column is the stored sigil-link STRING.
    const stored = v.q.result![0].author_cf_link;
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

    const resultCell = runtime.getCell(
      space,
      "decode-null",
      p.resultSchema,
      tx,
    );
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
    expect(v.q.result![0].author_cf_link).toBeNull();
  });

  // BLOCKED at the runner layer — requires `sqliteQuery<Row>` transformer
  // injection (Piece B) so the CONSUMER's schema carries `asCell` for link
  // columns. See the file header + plans/node-output-schema-propagation.md.
  it.skip("surfaces q.result[i].<col>_cf_link as a live Cell automatically", () => {
    // Target (currently unreachable without consumer-side asCell schema):
    //   const q = sqliteQuery<{ author_cf_link: Cell<{ name: string }> }>(...);
    //   const row = q.result[0];
    //   expect(isCell(row.author_cf_link)).toBe(true);
    //   expect(row.author_cf_link.get()).toEqual({ name: "Ada" });
    expect(isCell).toBeDefined();
  });
});

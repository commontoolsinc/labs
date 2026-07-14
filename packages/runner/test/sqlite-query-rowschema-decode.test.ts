// Piece A (runtime): sqliteQuery decodes asCell-marked `_cf_link` columns from
// sigil STRINGS to sigil OBJECTS, driven by the transformer-injected `rowSchema`.
// A consumer reading the result under its `<Row>` schema (Cell<T> -> asCell) then
// rehydrates the object to a live Cell.
//
// This drives the builtin directly with a `rowSchema` input and simulates the
// consumer's typed read via `asSchema` (the runner has no transformer, so the
// real `<Row>`-typed consumer schema only exists through `cf check` — that full
// path is the integration test). It proves the runtime half: rowSchema -> stored
// sigil object -> asCell read -> live Cell.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { encodeCfLinkValue } from "../src/builtins/sqlite/cf-link.ts";

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

type QueryState = {
  rows: Array<Record<string, unknown>>;
  withheld?: number;
};

describe("sqliteQuery rowSchema-driven _cf_link decode (Piece A runtime)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  let signer: Identity;
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(`rowdec-${crypto.randomUUID()}`);
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

  // Seed rows through the real write path (a folded `sqlite` op committed via a
  // tx) — there is no standalone write RPC.
  const seedSqlite = async (
    db: SqliteDbRef,
    sql: string,
    params?: readonly unknown[],
  ): Promise<void> => {
    const seedTx = runtime.edit();
    seedTx.recordSqliteWrite!(space, { op: "sqlite", db, sql, params });
    const res = await seedTx.commit();
    if (res.error) throw res.error;
  };

  it("decodes a rowSchema asCell column so an asCell read yields a live Cell", async () => {
    // A committed target + a seeded row holding its encoded link.
    const author = runtime.getCell<{ name: string }>(
      space,
      "author",
      undefined,
      tx,
    );
    author.set({ name: "Ada" });
    const encoded = encodeCfLinkValue(author);

    const db: SqliteDbRef = {
      id: `of:rowdec-${crypto.randomUUID()}`,
      tables: {
        people: table({ id: "integer primary key", author_cf_link: "text" }),
      },
    };
    await seedSqlite(
      db,
      "INSERT INTO people (author_cf_link) VALUES (?)",
      [encoded],
    );
    await tx.commit();

    // The rowSchema the transformer would inject for
    // db.query<{ author_cf_link: Cell<{ name: string }> }>(...).
    const rowSchema = {
      type: "object",
      properties: {
        author_cf_link: { asCell: ["cell"], type: "object" },
      },
    } as unknown as JSONSchema;

    const tx2 = runtime.edit();
    const p = cf.pattern(() =>
      cf.sqliteQuery(
        {
          db,
          sql: "SELECT author_cf_link FROM people ORDER BY id",
          reactOn: db,
          // transformer-injected for the typed form:
          rowSchema,
          // deno-lint-ignore no-explicit-any
        } as any,
      )
    );
    const resultCell = runtime.getCell(
      space,
      "rowdec-result",
      p.resultSchema,
      tx2,
    );
    const result = runtime.run(tx2, p, {}, resultCell);
    await tx2.commit();

    const v = await waitUntil<QueryState>(
      runtime,
      result,
      (s) => Array.isArray(s.rows) && s.rows.length === 1,
    );
    expect(v.rows).toHaveLength(1);

    // Read the result under the consumer's <Row> schema (asCell on the link
    // column) — exactly what the transformer lowers a typed consumer read to.
    const wrapSchema = {
      type: "object",
      additionalProperties: true,
      properties: {
        rows: { type: "array", items: rowSchema },
      },
    } as unknown as JSONSchema;
    const tree = result.asSchema(wrapSchema).get() as {
      rows?: Array<{ author_cf_link?: unknown }>;
    };
    const col = tree.rows?.[0]?.author_cf_link;
    expect(isCell(col)).toBe(true);
    expect((col as { get(): unknown }).get()).toEqual({ name: "Ada" });
  });
});

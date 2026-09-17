/**
 * An ordinary `sqliteQuery` carries a stored INTEGER into its result whole: an
 * epoch-millisecond timestamp as a `number`, and a value past 2^53 as a
 * `bigint`.
 *
 * The pool's own test establishes what the read connection returns. This
 * establishes the rest of the path an unlabeled query takes with that value:
 * across the provider, through the write-back into the result cell, and out
 * of a read of that cell. An unlabeled row is keyed on its content, so a
 * `bigint` has to survive being hashed as well as being stored.
 *
 * Spec: docs/specs/sqlite-builtin/01-api.md ("The `Row` type argument").
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type QueryState = {
  pending: boolean;
  result?: Array<Record<string, unknown>>;
  error?: unknown;
};

describe("sqliteQuery over a stored INTEGER", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  let space: `did:${string}:${string}`;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `whole-int-${crypto.randomUUID()}`,
    );
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("returns a timestamp as a `number` and a value past 2^53 as a `bigint`", async () => {
    // The values are SQL literals rather than bound parameters, so what the
    // row holds does not depend on how a parameter is encoded.

    const db: SqliteDbRef = {
      id: `of:whole-int-${crypto.randomUUID()}`,
      tables: { readings: table({ id: "integer primary key", n: "integer" }) },
    };
    const seedTx = runtime.edit();
    seedTx.recordSqliteWrite!(space, {
      op: "sqlite",
      db,
      sql: "INSERT INTO readings (id, n) VALUES " +
        "(1, 1789000000000), (2, 9007199254740993)",
    });
    const seeded = await seedTx.commit();
    expect(seeded.error).toBeUndefined();

    const tx = runtime.edit();
    const pattern = cf.pattern(() =>
      cf.sqliteQuery({
        db,
        sql: "SELECT n FROM readings ORDER BY id",
        reactOn: db,
        // The raw handle object stands in for a `sqliteDatabase` result here.
        // deno-lint-ignore no-explicit-any
      } as any)
    );
    const resultCell = runtime.getCell(
      space,
      "whole-int-result",
      pattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, pattern, {}, resultCell);
    await tx.commit();

    const state = await waitForCellValue<QueryState>(
      runtime,
      result,
      (s) =>
        s?.pending === false &&
        (s.error !== undefined ||
          (Array.isArray(s.result) && s.result.length === 2)),
    );
    expect(state.error).toBeUndefined();
    expect(state.result).toEqual([
      { n: 1789000000000 },
      { n: 9007199254740993n },
    ]);
  });
});

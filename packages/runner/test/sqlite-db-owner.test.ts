// The sqlite db handle's `owner` (CFC Phase 3: resolves the row rule's
// dbOwner() and {__ctDbOwner} ceiling placeholders) is minted ONCE, by the
// initialization that CREATES the handle. The sqliteDatabase builtin re-runs
// its init in every runtime that opens the piece (the action's `initialized`
// guard is per-runtime-instance), so a re-initialization must preserve the
// committed owner rather than re-mint the CURRENT acting principal — last
// opener wins would rotate row-read authority to whoever opened the piece
// most recently. Companion multi-runtime repro:
// packages/patterns/integration/sqlite-db-owner-multi-runtime.test.ts.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("sqliteDatabase handle owner", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cf: ReturnType<typeof createBuilder>["commonfabric"];
  // Swappable acting principal: models a DIFFERENT user's runtime re-running
  // the builtin without needing a second realm.
  let acting: string;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    acting = "did:test:alice";
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: `principal:${acting}`,
        actingPrincipal: acting,
        revision: "test",
      }),
    });
    ({ commonfabric: cf } = createTrustedBuilder(runtime));
  });

  afterEach(async () => {
    await runtime.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("mints owner at creation and keeps it across re-initialization by another principal", async () => {
    const dbPattern = cf.pattern(() =>
      cf.sqliteDatabase({
        tables: {
          notes: cf.table({ id: "integer primary key", body: "text" }),
        },
      })
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "sqlite-db-owner",
      dbPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, dbPattern, {}, resultCell);
    await tx.commit();

    const minted = await waitUntil<SqliteDbRef>(
      runtime,
      result,
      (v) => v?.owner !== undefined,
    );
    expect(minted.owner).toBe("did:test:alice");

    // Re-initialization: stop the piece and run the same pattern into the
    // same result cell (same causal ids → same committed handle) with a
    // fresh builtin instance acting as ANOTHER principal — the single-realm
    // equivalent of a second user's runtime opening the piece.
    runtime.runner.stop(result);
    acting = "did:test:bob";
    const tx2 = runtime.edit();
    runtime.run(tx2, dbPattern, {}, resultCell);
    await tx2.commit();

    // A correct re-initialization leaves the handle value UNCHANGED, so there
    // is no value transition to wait for — a `waitUntil(owner defined)` here
    // would be satisfied by the pre-restart state before the re-run executes.
    // Instead drive the fresh builtin action under observation (pull-mode
    // runs effects only while observed) and wait for full quiescence
    // (red-checked: an unconditional re-mint IS observed after this wait).
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      await runtime.settled();
    } finally {
      cancel();
    }

    expect((result.get() as SqliteDbRef).owner).toBe("did:test:alice");
  });
});

// Wait until `pred(cell value)` holds. A `sink` keeps the effect chain live
// (pull-mode runs effects only while observed); the loop is fully awaited and
// the sink is cancelled in `finally`, so nothing runs after the test disposes
// the engine (same idiom as sqlite-builtins.test.ts).
async function waitUntil<T>(
  runtime: Runtime,
  // deno-lint-ignore no-explicit-any
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
    throw new Error("timeout waiting for sqlite db handle");
  } finally {
    cancel?.();
  }
}

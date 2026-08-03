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
import { userExecutionContextKey } from "@commonfabric/memory/v2";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
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

    const minted = await waitForCellValue<SqliteDbRef>(
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
    // is no value transition to wait for — a `waitForCellValue(owner defined)`
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

// ---------------------------------------------------------------------------
// A5/G1 follow-on (owner ruling, 2026-07-29): "We still know for which user we
// run this, why not use that? It's what we do today — the database is created
// on the server!"
//
// A server-side FIRST run mints the handle. Deriving the owner from the
// ambient `trustSnapshotProvider()` makes that the EXECUTOR's lease principal,
// not the user the run serves — so `dbOwner()` row rules and `{__ctDbOwner}`
// ceiling placeholders would admit the sponsor rather than the user, on a db
// the user believes is theirs. The acting user IS known: every
// scheduler-driven run on the executor executes under its lane as the AMBIENT
// acting lane (`runtime.scheduler.setActionRunWrapper` →
// `storage.runWithExecutionLane`, C1.9c), the runner-side twin of
// `SqliteQueryRequest.actingContext` (57dd8da7f). This is that seam's
// WRITE-time leg.
//
// The seam is strictly additive, and the ADDITIVITY pin is the suite above:
// with no lane acting, the owner is still the ambient trust snapshot's
// principal, byte-identically. Naming a lane only NARROWS.
//
// Red leg reads exactly like 57dd8da7f's: expected alice, got sponsor.
describe("sqliteDatabase handle owner under an execution lane", () => {
  it("derives the owner from the acting lane, not from the lease sponsor", async () => {
    const sponsor = await Identity.fromPassphrase("sqlite lane sponsor");
    const sponsorSpace = sponsor.did();
    const alice = "did:test:alice-lane";
    const lane = userExecutionContextKey(alice);
    // The handle value never reaches the committed doc here (the emulated host
    // has no grant for alice's lane, so the lane-attributed commit does not
    // land), so read the minted ref off the commit the builtin produced — that
    // is where "which principal did this run mint for" is observable.
    const mintedRefs: SqliteDbRef[] = [];
    const storageManager = StorageManager.emulate({
      as: sponsor,
      actionTransactionRouter(input) {
        for (const operation of input.commit.operations) {
          const value = (operation as { value?: unknown }).value;
          const inner = (value as { value?: unknown } | undefined)?.value;
          if (
            inner && typeof inner === "object" &&
            typeof (inner as SqliteDbRef).id === "string" &&
            (inner as SqliteDbRef).tables !== undefined
          ) {
            mintedRefs.push(inner as SqliteDbRef);
          }
        }
        return { disposition: "upstream" };
      },
    });
    // The Runtime's DEFAULT trust snapshot: the storage signer, i.e. the
    // executor's lease sponsor. That default is precisely what the executor
    // Worker runs with, and precisely what the pre-fix code minted as owner.
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    expect(runtime.trustSnapshotProvider()?.actingPrincipal).toBe(sponsorSpace);
    // The executor Worker's own mechanism, verbatim
    // (`executor-worker.ts`, `runtime.scheduler.setActionRunWrapper`): every
    // scheduler-driven run executes with the action's lane as the AMBIENT
    // acting lane, covering the run's synchronous extent — which is exactly
    // where `sqliteDatabase` mints its handle.
    runtime.scheduler.setActionRunWrapper((_action, run) =>
      storageManager.runWithExecutionLane(sponsorSpace, lane, run)
    );
    const { commonfabric: laneCf } = createTrustedBuilder(runtime);
    try {
      const dbPattern = laneCf.pattern(() =>
        laneCf.sqliteDatabase({
          tables: {
            notes: laneCf.table({ id: "integer primary key", body: "text" }),
          },
        })
      );
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        sponsorSpace,
        "sqlite-db-owner-lane",
        dbPattern.resultSchema,
        tx,
      );
      const result = runtime.run(tx, dbPattern, {}, resultCell);
      await tx.commit();
      const cancel = result.sink(() => {});
      try {
        for (let i = 0; i < 60 && mintedRefs.length === 0; i++) {
          await runtime.idle();
          // `clock.tick` rather than a wall-clock sleep: a positive-delay
          // timer armed from a `test/` file freezes under the fake clock.
          await clock.tick(15);
        }
      } finally {
        cancel();
      }
      expect(mintedRefs.length).toBeGreaterThan(0);
      expect(mintedRefs[0].owner).toBe(alice);
    } finally {
      await runtime.idle();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

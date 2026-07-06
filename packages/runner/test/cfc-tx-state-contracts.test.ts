import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-tx-state-contracts");

// Contracts of the transaction's CFC control surface that no other suite
// pins directly: the flow-labels anti-downgrade pin, the write-once sink
// ceiling, late-activity invalidation of a prepared transaction, and the
// diagnostics seams. All are part of the audit-S3 posture the read-only
// state view (#4517) completes.
describe("CFC tx state contracts", () => {
  const withTx = async (
    fn: (runtime: Runtime, tx: ExtendedStorageTransaction) => Promise<void>,
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      await fn(runtime, runtime.edit() as ExtendedStorageTransaction);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  };

  it("the flow-labels persist pin cannot be weakened mid-transaction", async () => {
    await withTx(async (_runtime, tx) => {
      tx.setCfcFlowLabelsMode("persist");
      expect(() => tx.setCfcFlowLabelsMode("observe")).toThrow(
        "cannot be weakened",
      );
      expect(() => tx.setCfcFlowLabelsMode("off")).toThrow(
        "cannot be weakened",
      );
      // Re-asserting persist is fine.
      tx.setCfcFlowLabelsMode("persist");
      expect(tx.getCfcState().flowLabelsMode).toBe("persist");
      await tx.commit();
    });
  });

  it("the sink confidentiality ceiling is write-once (a later call is ignored)", async () => {
    // The Runtime establishes the ceiling at tx creation; code holding a
    // Cell must not be able to relax it afterwards.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      tx.setCfcSinkMaxConfidentiality({ fetchJson: ["anything"] });
      expect(tx.getCfcState().sinkMaxConfidentiality).toEqual({
        fetchJson: [],
      });
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("late trigger reads and writes invalidate a prepared transaction; reasons accumulate", async () => {
    await withTx(async (runtime, tx) => {
      runtime.getCell(signer.did(), "tx-contracts-out", undefined, tx).set({
        v: 1,
      });
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      // Trigger reads arriving after prepare invalidate the digest.
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id: "of:tx-contracts-late" as `${string}:${string}`,
        type: "application/json",
        path: ["value"],
      }]);
      const prepare = tx.getCfcState().prepare;
      expect(prepare.status).toBe("invalidated");
      expect(
        (prepare as { status: string; reasons: readonly string[] }).reasons,
      ).toContainEqual("trigger-reads-after-prepare");
      // A second invalidation appends to the existing reasons rather than
      // replacing them.
      tx.invalidateCfc("test-second-reason");
      expect(
        (tx.getCfcState().prepare as {
          status: string;
          reasons: readonly string[];
        }).reasons,
      ).toEqual(["trigger-reads-after-prepare", "test-second-reason"]);
      await tx.commit();
    });
  });

  it("a write after prepare invalidates the prepared digest", async () => {
    await withTx(async (runtime, tx) => {
      const cell = runtime.getCell(
        signer.did(),
        "tx-contracts-write-late",
        undefined,
        tx,
      );
      cell.set({ v: 1 });
      const id = cell.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      // Read-free write (cell.set journals a read first, which would
      // invalidate as read-after-prepare before the write is seen).
      tx.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id,
        path: [],
      }, { value: { v: 2 } });
      const prepare = tx.getCfcState().prepare;
      expect(prepare.status).toBe("invalidated");
      expect(
        (prepare as { status: string; reasons: readonly string[] }).reasons,
      ).toContainEqual("write-after-prepare");
      await tx.commit();
    });
  });

  it("noteCfcSinkReleaseReject lands in diagnostics", async () => {
    await withTx(async (_runtime, tx) => {
      tx.noteCfcSinkReleaseReject({
        sink: "fetchJson",
        effectId: "fetchJson:tx-contracts",
        detail: "test-detail",
      });
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.includes("fetchJson:tx-contracts") && d.includes("test-detail")
        ),
      ).toBe(true);
      await tx.commit();
    });
  });
});

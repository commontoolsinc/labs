// The transaction's side of a materialized read's instant.
//
// A read resolving against an earlier epoch describes a different moment than
// the transaction's caches do, so those caches stand aside for it. And a
// wrapper answers for the instant exactly as the transaction it wraps does,
// which is what keeps a read taken through `Cell.sample()` describing the same
// moment as one taken directly.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("extended-storage-transaction");
const space = signer.did();

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

describe("extended-storage-transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const seeded = async (cause: string) => {
    const write = runtime.edit();
    runtime.getCell(space, cause, undefined, write).set({ title: "before" });
    await write.commit();
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    return { tx, cell: runtime.getCell(space, cause, SCHEMA, tx) };
  };

  describe("the read-result cache under an epoch", () => {
    it("serves nothing while a read resolves against an earlier epoch", () => {
      const tx = runtime.edit();
      // Optional on the interface, and the behavior under test is what it
      // does, so a transaction without it has nothing to say.
      expect(typeof tx.getCachedReadResult).toBe("function");
      tx.setCachedReadResult!("key", "variant", 1);
      expect(tx.getCachedReadResult!("key", "variant")).toEqual({ value: 1 });

      const previous = tx.enterReadEpoch(0);
      expect(tx.getCachedReadResult!("key", "variant")).toBeUndefined();
      tx.exitReadEpoch(previous);

      expect(tx.getCachedReadResult!("key", "variant")).toEqual({ value: 1 });
      tx.abort("done");
    });

    it("keeps nothing taken while a read resolves against an earlier epoch", () => {
      const tx = runtime.edit();

      const previous = tx.enterReadEpoch(0);
      tx.setCachedReadResult!("key", "variant", 2);
      tx.exitReadEpoch(previous);

      // Had it been kept, this would answer with the value taken under the
      // epoch — a materialized read's value served to a current one.
      expect(tx.getCachedReadResult!("key", "variant")).toBeUndefined();
      tx.abort("done");
    });
  });

  describe("commit on a transaction that is no longer open", () => {
    // A second commit reports the transaction's terminal state as its result.
    // It runs none of the commit-path work: the CFC relevance probes read
    // stored metadata through the transaction, which admits no reads once its
    // commit is in flight, settled, or aborted. The underlying transaction
    // holds a single commit verdict, which stays with the commit that is
    // running.

    it("returns the completion error while the first commit is in flight", async () => {
      const tx = runtime.edit();
      runtime.getCell(space, "double-commit", undefined, tx).set({
        title: "once",
      });
      const flushed: string[] = [];
      const verdicts: string[] = [];
      const settlements: string[] = [];
      tx.enqueuePostCommitEffect({
        id: "double-commit-effect",
        kind: "test",
        flush: () => {
          flushed.push("flushed");
        },
      });
      tx.addVerdictCallback((_tx, result) => {
        verdicts.push(result.error ? result.error.name : "ok");
      });
      tx.addCommitCallback((_tx, result) => {
        settlements.push(result.error ? result.error.name : "ok");
      });

      const first = tx.commit();
      expect(tx.status().status).toBe("pending");
      const second = await tx.commit();
      expect(second.error?.name).toBe("StorageTransactionCompleteError");

      expect((await first).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      expect(verdicts).toEqual(["ok"]);
      expect(settlements).toEqual(["ok"]);
      expect(flushed).toEqual(["flushed"]);
    });

    it("returns the completion error after the first commit settled", async () => {
      const tx = runtime.edit();
      runtime.getCell(space, "double-commit-settled", undefined, tx).set({
        title: "once",
      });
      expect((await tx.commit()).error).toBeUndefined();
      const second = await tx.commit();
      expect(second.error?.name).toBe("StorageTransactionCompleteError");
    });

    it("returns the abort reason after the transaction was aborted", async () => {
      const tx = runtime.edit();
      runtime.getCell(space, "commit-after-abort", undefined, tx).set({
        title: "once",
      });
      tx.abort("done with this one");
      const result = await tx.commit();
      expect(result.error?.name).toBe("StorageTransactionAborted");
    });

    describe("with flow labels persisted", () => {
      // The flow-labels probe is what reads stored metadata, and it runs only
      // with the dial on, which the shared runtime leaves off. An aborted
      // transaction keeps its read and write activity so the scheduler can
      // rebuild the action's dependencies, so the probe has work to walk
      // there; a settled one does not.
      beforeEach(async () => {
        await runtime.dispose();
        await storageManager.close();
        storageManager = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          cfcFlowLabels: "persist",
        });
      });

      it("returns the completion error while the first commit is in flight", async () => {
        const tx = runtime.edit();
        runtime.getCell(space, "labeled-double-commit", undefined, tx).set({
          title: "once",
        });
        const first = tx.commit();
        const second = await tx.commit();
        expect(second.error?.name).toBe("StorageTransactionCompleteError");
        expect((await first).error).toBeUndefined();
      });

      it("returns the abort reason after the transaction was aborted", async () => {
        const tx = runtime.edit();
        runtime.getCell(space, "labeled-commit-after-abort", undefined, tx)
          .set({ title: "once" });
        tx.abort("done with this one");
        const result = await tx.commit();
        expect(result.error?.name).toBe("StorageTransactionAborted");
      });
    });
  });

  describe("a wrapped transaction", () => {
    it("answers for the instant as the transaction it wraps does", async () => {
      const { tx, cell } = await seeded("wrapped-instant");
      const wrapper = createNonReactiveTransaction(tx);
      try {
        expect(wrapper.hasWrites()).toBe(false);

        const view = cell.withTx(wrapper).get() as { title: string };
        cell.withTx(tx).key("title").set("after");

        expect(wrapper.hasWrites()).toBe(true);
        // The wrapper carried the epoch down, so the view it handed back keeps
        // describing the moment it was taken.
        expect(view.title).toBe("before");
        expect((cell.withTx(wrapper).get() as { title: string }).title).toBe(
          "after",
        );
      } finally {
        await tx.commit();
      }
    });

    it("records a refusal detail on the transaction it wraps", async () => {
      const { tx } = await seeded("wrapped-refusal-detail");
      const wrapper = createNonReactiveTransaction(tx);
      try {
        wrapper.recordCfcRefusalDetail({
          gate: "sink-ceiling",
          sink: "fetchText",
          offendingAtoms: ['"medical"'],
          inputs: [],
          attribution: "none",
          reason: "sink-request confidentiality exceeds ceiling for " +
            'fetchText: "medical"',
        });

        // The wrapper shares the inner transaction's CFC state, so a gate
        // that refuses while running under a wrapper describes itself to the
        // transaction that will be asked for the refusal.
        expect(tx.getCfcState().refusalDetails).toEqual([{
          gate: "sink-ceiling",
          sink: "fetchText",
          offendingAtoms: ['"medical"'],
          inputs: [],
          attribution: "none",
          reason: "sink-request confidentiality exceeds ceiling for " +
            'fetchText: "medical"',
        }]);
      } finally {
        await tx.commit();
      }
    });
  });
});

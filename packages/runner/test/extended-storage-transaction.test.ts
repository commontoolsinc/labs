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
import {
  createNonReactiveTransaction,
  type ExtendedStorageTransaction,
} from "../src/storage/extended-storage-transaction.ts";
import { RuntimeOwnedStores } from "../src/cfc/runtime-owned-stores.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
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

  describe("a write-policy input's recorder", () => {
    // A gate that ACTS on a write-policy input asks who recorded it, because
    // this method is on the public interface and pattern-authored code
    // reaches the transaction its cells are bound to. The authorization
    // travels as an argument of the one call that carries it, so the answer
    // has to be per input rather than per transaction.

    const input = (id: string) =>
      ({
        kind: "structural-provenance",
        target: { space, id, scope: "space", path: [] },
        claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
        sources: [],
      }) as const;

    it("returns `true` for an input recorded with the authorization", async () => {
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(
          input("of:authorized"),
          runtimeWritePolicyAuthorization,
        );
        const [recorded] = tx.getCfcState().writePolicyInputs;
        expect(tx.isRuntimeWritePolicyInput(recorded)).toBe(true);
      } finally {
        await tx.commit();
      }
    });

    it("returns `false` for an input recorded without it", async () => {
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(input("of:unauthorized"));
        const [recorded] = tx.getCfcState().writePolicyInputs;
        expect(tx.isRuntimeWritePolicyInput(recorded)).toBe(false);
      } finally {
        await tx.commit();
      }
    });

    it("answers per input rather than per transaction", async () => {
      // The mark reaches the one input its call carried, so recording an
      // authorized input does not lend the mark to an unauthorized one
      // beside it — in either order.
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(
          input("of:first-authorized"),
          runtimeWritePolicyAuthorization,
        );
        tx.recordCfcWritePolicyInput(input("of:then-plain"));
        tx.recordCfcWritePolicyInput(
          input("of:then-authorized"),
          runtimeWritePolicyAuthorization,
        );
        expect(
          tx.getCfcState().writePolicyInputs.map((recorded) =>
            tx.isRuntimeWritePolicyInput(recorded)
          ),
        ).toEqual([true, false, true]);
      } finally {
        await tx.commit();
      }
    });

    it("returns `false` for an input this transaction never recorded", async () => {
      // The mark is held by reference to the frozen record the transaction
      // owns, so a look-alike built outside it answers `false` however
      // exactly its fields match.
      const tx = runtime.edit();
      try {
        tx.recordCfcWritePolicyInput(
          input("of:owned"),
          runtimeWritePolicyAuthorization,
        );
        expect(tx.isRuntimeWritePolicyInput(input("of:owned"))).toBe(false);
      } finally {
        await tx.commit();
      }
    });
  });
  describe("the enrollment of a store the runtime owns", () => {
    // The enrollment answers for the whole runtime rather than for one
    // transaction, which is what carries it to the reactive updates and
    // settled requests that fill such a store. Every id in it is derivable
    // from a piece's cause, so the answer takes the runtime's mark: without
    // it, pattern-authored code reaching `cell.tx` could ask whether a given
    // piece is running here.

    const address = (id: string) =>
      ({ space, id, scope: "space", path: [] }) as const;

    it("answers for a store a previous transaction enrolled", async () => {
      const first = runtime.edit();
      first.enrollRuntimeOwnedStore(
        address("of:enrolled"),
        "owner-key",
        runtimeWritePolicyAuthorization,
      );
      await first.commit();

      const later = runtime.edit();
      try {
        expect(
          later.isRuntimeOwnedStore(
            space,
            "of:enrolled",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await later.commit();
      }
    });

    it("answers `false` to a caller without the runtime's mark", async () => {
      const tx = runtime.edit();
      try {
        tx.enrollRuntimeOwnedStore(
          address("of:unmarked-reader"),
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(tx.isRuntimeOwnedStore(space, "of:unmarked-reader")).toBe(false);
        expect(
          tx.isRuntimeOwnedStore(
            space,
            "of:unmarked-reader",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await tx.commit();
      }
    });

    it("is answered through a wrapper as through what it wraps", async () => {
      const tx = runtime.edit();
      const wrapper = createNonReactiveTransaction(tx);
      try {
        tx.enrollRuntimeOwnedStore(
          address("of:through-a-wrapper"),
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(
          wrapper.isRuntimeOwnedStore(
            space,
            "of:through-a-wrapper",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
        expect(
          wrapper.isRuntimeOwnedStore(space, "of:through-a-wrapper"),
        ).toBe(false);
      } finally {
        await tx.commit();
      }
    });

    it("enrolls through a wrapper into what it wraps", async () => {
      const tx = runtime.edit();
      const wrapper = createNonReactiveTransaction(tx);
      try {
        wrapper.enrollRuntimeOwnedStore(
          address("of:enrolled-through-a-wrapper"),
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(
          tx.isRuntimeOwnedStore(
            space,
            "of:enrolled-through-a-wrapper",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await tx.commit();
      }
    });

    it("answers for a store enrolled at a different scope instance", async () => {
      // The store key omits scope deliberately: the scope instances of one
      // causal cell are instances of the same store, materialized for the
      // same piece, so an enrollment made while the store was addressed at
      // one scope has to answer the write that arrives at another. Keying on
      // scope would enroll whichever instance the runtime minted first and
      // refuse the rest.
      const tx = runtime.edit();
      try {
        tx.enrollRuntimeOwnedStore(
          { space, id: "of:scoped-instance", scope: "session", path: [] },
          "owner-key",
          runtimeWritePolicyAuthorization,
        );
        expect(
          tx.isRuntimeOwnedStore(
            space,
            "of:scoped-instance",
            runtimeWritePolicyAuthorization,
          ),
        ).toBe(true);
      } finally {
        await tx.commit();
      }
    });

    it("takes one handover of the runtime's set, not two", async () => {
      // `Runtime.edit` hands its set to every transaction it makes, so a
      // second handover would swap the set a transaction already answers
      // from.
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        expect(() => tx.configureRuntimeOwnedStores(new RuntimeOwnedStores()))
          .toThrow("already configured");
      } finally {
        await tx.commit();
      }
    });
  });
});

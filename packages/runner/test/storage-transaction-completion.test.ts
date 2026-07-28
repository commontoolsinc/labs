import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// A transaction's read and write activity is consumed while it is open: the
// scheduler takes the reactivity log when the action that opened the
// transaction finishes, and the commit path takes the write details before the
// result is known. Holding that activity past completion pins every address
// the transaction touched, so anything that keeps a completed transaction — a
// cell bound to it, a cleanup closure that captured it — keeps those too. A
// list projecting a window that moves opens one transaction per move, so this
// is the difference between a bounded working set and one that grows with
// every page turn.

const signer = await Identity.fromPassphrase("storage transaction completion");
const space = signer.did();

describe("a completed storage transaction", () => {
  it("reports no activity once it has committed", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "transaction-completion",
        undefined,
      );
      const tx = runtime.edit();
      cell.withTx(tx).set({ value: 1 });
      cell.withTx(tx).get();

      const readLog = (): { reads: unknown[]; writes: unknown[] } => {
        const log = tx.getReactivityLog?.();
        if (!log) throw new Error("transaction has no reactivity log");
        return log;
      };
      const open = readLog();
      expect(open.writes.length).toBeGreaterThan(0);

      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      const completed = readLog();
      expect(completed.reads.length).toBe(0);
      expect(completed.writes.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reports no activity once it has failed", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "transaction-completion-failure",
        undefined,
      );
      const tx = runtime.edit();
      cell.withTx(tx).set({ value: 1 });
      await tx.commit();

      // A second commit on the same transaction fails; the transaction still
      // holds no activity afterwards.
      const completed = tx.getReactivityLog?.();
      if (!completed) throw new Error("transaction has no reactivity log");
      expect(completed.reads.length).toBe(0);
      expect(completed.writes.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

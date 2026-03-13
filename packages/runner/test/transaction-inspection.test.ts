import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { txToReactivityLog } from "../src/scheduler.ts";
import type {
  IExtendedStorageTransaction,
  ITransactionJournal,
  TransactionReactivityLog,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("transaction-inspection");
const space = signer.did();

class EmptyJournal implements ITransactionJournal {
  activity(): Iterable<any> {
    return [];
  }

  novelty(_space: any): Iterable<any> {
    return [];
  }

  history(_space: any): Iterable<any> {
    return [];
  }
}

describe("transaction inspection", () => {
  it("uses direct reactivity logs when provided", () => {
    const journal = new EmptyJournal();
    const tx = {
      journal,
      getReactivityLog: () => ({
        reads: [{
          space: "did:key:test" as any,
          id: "of:read" as any,
          type: "application/json",
          path: ["field"],
        }],
        shallowReads: [],
        writes: [{
          space: "did:key:test" as any,
          id: "of:write" as any,
          type: "application/json",
          path: ["field"],
        }],
      }),
      status: () => ({ status: "done" as const, journal }),
      tx: {} as any,
    } as unknown as IExtendedStorageTransaction;

    assertEquals(txToReactivityLog(tx), {
      reads: [{
        space: "did:key:test",
        id: "of:read",
        type: "application/json",
        path: ["field"],
      }],
      shallowReads: [],
      writes: [{
        space: "did:key:test",
        id: "of:write",
        type: "application/json",
        path: ["field"],
      }],
    });
  });

  it("uses the native v2 transaction reactivity log hook", async () => {
    const storageManager = StorageManager.emulate({ as: signer });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-direct-v2" as const;
      tx.write({
        space,
        id,
        type: "application/json",
        path: [],
      }, { value: { count: 1 } });
      tx.read({
        space,
        id,
        type: "application/json",
        path: ["value"],
      });

      const expected: TransactionReactivityLog = {
        reads: [{
          space,
          id,
          type: "application/json",
          path: [],
        }],
        shallowReads: [],
        writes: [{
          space,
          id,
          type: "application/json",
          path: [],
        }],
      };
      const direct = tx.getReactivityLog?.();
      assertExists(direct);
      assertEquals(direct, expected);

      const extended = {
        tx,
        journal: tx.journal,
        status: tx.status.bind(tx),
      } as unknown as IExtendedStorageTransaction;
      assertEquals(txToReactivityLog(extended), expected);
    } finally {
      await storageManager.close();
    }
  });
});

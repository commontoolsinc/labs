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
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import {
  getTransactionReadActivities,
  getTransactionWriteDetails,
} from "../src/storage/transaction-inspection.ts";

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
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

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

  it("forwards native v2 hooks through extended transaction wrappers", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-wrapped-v2" as const;
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

      const extended = new ExtendedStorageTransaction(tx);
      const wrapped = new TransactionWrapper(extended);

      assertEquals(extended.getReactivityLog?.(), expected);
      assertEquals(wrapped.getReactivityLog?.(), expected);
      assertEquals(txToReactivityLog(wrapped), expected);
    } finally {
      await storageManager.close();
    }
  });

  it("uses the native v2 read activity hook without journal replay", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-read-activities-v2" as const;
      tx.read({
        space,
        id,
        type: "application/json",
        path: ["value", "count"],
      }, { nonRecursive: true, meta: { source: "direct-hook" } });

      assertEquals([...getTransactionReadActivities(tx)], [{
        space,
        id,
        type: "application/json",
        path: ["value", "count"],
        meta: { source: "direct-hook" },
        nonRecursive: true,
      }]);
    } finally {
      await storageManager.close();
    }
  });

  it("preserves interleaved journal activity order on the native v2 path", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const tx = storageManager.edit();
      const id = "test:transaction-inspection-activity-order-v2" as const;
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
      tx.write({
        space,
        id,
        type: "application/json",
        path: ["value", "count"],
      }, 2);

      assertEquals([...tx.journal.activity()], [
        {
          write: {
            space,
            id,
            type: "application/json",
            path: [],
          },
        },
        {
          read: {
            space,
            id,
            type: "application/json",
            path: ["value"],
            meta: {},
          },
        },
        {
          write: {
            space,
            id,
            type: "application/json",
            path: ["value", "count"],
          },
        },
      ]);
    } finally {
      await storageManager.close();
    }
  });

  it("preserves the original previousValue in native v2 write details", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const seed = storageManager.edit();
      const id = "test:transaction-inspection-write-details-v2" as const;
      seed.write({
        space,
        id,
        type: "application/json",
        path: [],
      }, { value: { count: 1 } });
      await seed.commit();

      const tx = storageManager.edit();
      tx.write({
        space,
        id,
        type: "application/json",
        path: ["value", "count"],
      }, 2);
      tx.write({
        space,
        id,
        type: "application/json",
        path: ["value", "count"],
      }, 3);

      assertEquals([...getTransactionWriteDetails(tx, space)], [{
        address: {
          space,
          id,
          type: "application/json",
          path: ["value", "count"],
        },
        value: 3,
        previousValue: 1,
      }]);

      assertEquals([...tx.journal.novelty(space)], [{
        address: {
          id,
          type: "application/json",
          path: ["value", "count"],
        },
        value: 3,
      }]);

      assertEquals([...tx.journal.history(space)], [{
        address: {
          id,
          type: "application/json",
          path: ["value", "count"],
        },
        value: 1,
      }]);
    } finally {
      await storageManager.close();
    }
  });
});

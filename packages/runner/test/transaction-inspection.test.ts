import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { txToReactivityLog } from "../src/scheduler.ts";
import type {
  IExtendedStorageTransaction,
  ITransactionJournal,
  ITransactionWriteRequest,
  TransactionReactivityLog,
} from "../src/storage/interface.ts";
import {
  ExtendedStorageTransaction,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import { reactivityLogFromActivities } from "../src/storage/reactivity-log.ts";
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

  it("preserves non-document-prefixed paths in derived reactivity logs", () => {
    assertEquals(
      reactivityLogFromActivities([
        {
          read: {
            space: "did:key:test" as any,
            id: "of:read" as any,
            type: "application/json",
            path: ["links", "peer"],
            meta: {},
          },
        },
        {
          read: {
            space: "did:key:test" as any,
            id: "of:shallow" as any,
            type: "application/json",
            path: ["value", "items"],
            meta: {},
            nonRecursive: true,
          },
        },
        {
          write: {
            space: "did:key:test" as any,
            id: "of:write" as any,
            type: "application/json",
            path: ["meta", "updatedAt"],
          },
        },
      ]),
      {
        reads: [{
          space: "did:key:test",
          id: "of:read",
          type: "application/json",
          path: ["links", "peer"],
        }],
        shallowReads: [{
          space: "did:key:test",
          id: "of:shallow",
          type: "application/json",
          path: ["items"],
        }],
        writes: [{
          space: "did:key:test",
          id: "of:write",
          type: "application/json",
          path: ["meta", "updatedAt"],
        }],
      },
    );
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

  it("preserves full-document paths in native v2 reactivity logs", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const id =
        "test:transaction-inspection-direct-v2-document-paths" as const;

      const seed = storageManager.edit();
      seed.write({
        space,
        id,
        type: "application/json",
        path: [],
      }, {
        value: { count: 1 },
        source: { "/": "origin" },
        meta: { updatedAt: "before" },
      });
      await seed.commit();

      const tx = storageManager.edit();
      tx.read({
        space,
        id,
        type: "application/json",
        path: ["source"],
      });
      tx.write({
        space,
        id,
        type: "application/json",
        path: ["meta", "updatedAt"],
      }, "after");

      const expected: TransactionReactivityLog = {
        reads: [{
          space,
          id,
          type: "application/json",
          path: ["source"],
        }],
        shallowReads: [],
        writes: [{
          space,
          id,
          type: "application/json",
          path: ["meta", "updatedAt"],
        }],
      };

      assertEquals(tx.getReactivityLog?.(), expected);
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

  it("does not fan out batch writes when the wrapped transaction already handles them", () => {
    const writes: ITransactionWriteRequest[] = [{
      address: {
        space,
        id: "test:transaction-wrapper-write-values-1" as const,
        type: "application/json",
        path: ["count"],
      },
      value: 1,
    }, {
      address: {
        space,
        id: "test:transaction-wrapper-write-values-2" as const,
        type: "application/json",
        path: ["count"],
      },
      value: 2,
    }];
    const observed: ITransactionWriteRequest[] = [];
    const wrapped = new TransactionWrapper({
      writeValuesOrThrow(batch: Iterable<ITransactionWriteRequest>) {
        observed.push(...batch);
      },
      writeValueOrThrow() {
        throw new Error("wrapper should not replay batch writes");
      },
    } as unknown as IExtendedStorageTransaction);

    wrapped.writeValuesOrThrow(writes);

    assertEquals(observed, writes);
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

  it("throws when native v2 code tries to replay journal activity", async () => {
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

      assertThrows(
        () => [...tx.journal.activity()],
        Error,
        "V2 transactions do not support journal.activity()",
      );
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

  it("records the rewritten parent path when a single native v2 batch write materializes missing parents", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const id = "test:transaction-inspection-batch-parent-write-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        id,
        type: "application/json",
        path: [],
      }, { value: { count: 1 } });
      await seed.commit();

      const tx = storageManager.edit();
      const extended = new ExtendedStorageTransaction(tx);
      extended.writeValuesOrThrow([{
        address: {
          space,
          id,
          type: "application/json",
          path: ["profile", "name"],
        },
        value: "Ada",
      }]);

      assertEquals(extended.getReactivityLog(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          id,
          type: "application/json",
          path: [],
        }, {
          space,
          id,
          type: "application/json",
          path: ["profile"],
        }, {
          space,
          id,
          type: "application/json",
          path: ["profile", "name"],
        }],
      });

      assertEquals(
        [...getTransactionWriteDetails(extended, space)].map((detail) =>
          detail.address
        ),
        [{
          space,
          id,
          type: "application/json",
          path: ["value"],
        }],
      );
    } finally {
      await storageManager.close();
    }
  });

  it("records the rewritten parent path during native v2 batch materialization before later leaf writes", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const id =
        "test:transaction-inspection-batch-parent-write-run-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        id,
        type: "application/json",
        path: [],
      }, { value: { count: 1 } });
      await seed.commit();

      const tx = storageManager.edit();
      const extended = new ExtendedStorageTransaction(tx);
      extended.writeValuesOrThrow([{
        address: {
          space,
          id,
          type: "application/json",
          path: ["profile", "name"],
        },
        value: "Ada",
      }, {
        address: {
          space,
          id,
          type: "application/json",
          path: ["profile", "age"],
        },
        value: 42,
      }]);

      assertEquals(extended.getReactivityLog(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          id,
          type: "application/json",
          path: [],
        }, {
          space,
          id,
          type: "application/json",
          path: ["profile"],
        }, {
          space,
          id,
          type: "application/json",
          path: ["profile", "age"],
        }, {
          space,
          id,
          type: "application/json",
          path: ["profile", "name"],
        }],
      });

      assertEquals(
        [...getTransactionWriteDetails(extended, space)].map((detail) =>
          detail.address
        ),
        [{
          space,
          id,
          type: "application/json",
          path: ["value"],
        }, {
          space,
          id,
          type: "application/json",
          path: ["value", "profile", "age"],
        }],
      );
    } finally {
      await storageManager.close();
    }
  });

  it("derives precise array reactivity writes while keeping structural ancestors for length changes", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const id = "test:transaction-inspection-array-reactivity-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        id,
        type: "application/json",
        path: [],
      }, { value: { tags: ["one", "two"] } });
      await seed.commit();

      const tx = storageManager.edit();
      tx.write({
        space,
        id,
        type: "application/json",
        path: ["value", "tags", "0"],
      }, "zero");
      tx.write({
        space,
        id,
        type: "application/json",
        path: ["value", "tags", "length"],
      }, 1);

      assertEquals(tx.getReactivityLog?.(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          id,
          type: "application/json",
          path: ["tags"],
        }, {
          space,
          id,
          type: "application/json",
          path: ["tags", "0"],
        }, {
          space,
          id,
          type: "application/json",
          path: ["tags", "length"],
        }],
      });
    } finally {
      await storageManager.close();
    }
  });

  it("keeps same-length array element writes exact in native v2 reactivity logs", async () => {
    const storageManager = StorageManager.emulate({
      as: signer,
      memoryVersion: "v2",
    });

    try {
      const id =
        "test:transaction-inspection-array-element-reactivity-v2" as const;
      const seed = storageManager.edit();
      seed.write({
        space,
        id,
        type: "application/json",
        path: [],
      }, { value: { tags: ["one", "two"] } });
      await seed.commit();

      const tx = storageManager.edit();
      tx.write({
        space,
        id,
        type: "application/json",
        path: ["value", "tags", "0"],
      }, "zero");

      assertEquals(tx.getReactivityLog?.(), {
        reads: [],
        shallowReads: [],
        writes: [{
          space,
          id,
          type: "application/json",
          path: ["tags", "0"],
        }],
      });
    } finally {
      await storageManager.close();
    }
  });
});

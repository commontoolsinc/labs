import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { txToReactivityLog } from "../src/scheduler.ts";
import type {
  IExtendedStorageTransaction,
  ITransactionJournal,
} from "../src/storage/interface.ts";

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
});

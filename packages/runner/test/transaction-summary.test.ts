import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { summarizeTransaction, formatTransactionSummary } from "../src/storage/transaction-summary.ts";
import type { IExtendedStorageTransaction, ITransactionJournal, Activity } from "../src/storage/interface.ts";

// Mock transaction journal
class MockJournal implements ITransactionJournal {
  constructor(private activities: Activity[] = []) {}

  activity(): Iterable<Activity> {
    return this.activities;
  }

  novelty(_space: any): Iterable<any> {
    return [];
  }

  history(_space: any): Iterable<any> {
    return [];
  }
}

// Mock transaction
function createMockTransaction(activities: Activity[]): IExtendedStorageTransaction {
  const journal = new MockJournal(activities);

  return {
    journal,
    status: () => ({ status: "done" as const, journal }),
    tx: {} as any,
    addCommitCallback: () => {},
    readOrThrow: () => undefined,
    readValueOrThrow: () => undefined,
    writeOrThrow: () => {},
    deleteOrThrow: () => {},
    read: () => ({ ok: {} as any, error: undefined }),
    write: () => ({ ok: {} as any, error: undefined }),
    delete: () => ({ ok: {} as any, error: undefined }),
    commit: async () => ({ ok: {} as any, error: undefined }),
    abort: () => ({ ok: {} as any, error: undefined }),
    reader: () => ({} as any),
    writer: () => ({} as any),
  } as any;
}

describe("transaction-summary", () => {
  it("should summarize a read-only transaction", () => {
    const activities: Activity[] = [
      {
        read: {
          id: "of:abc123",
          type: "application/json",
          path: ["value"],
          space: "did:key:test" as any,
          meta: {},
        },
      },
      {
        read: {
          id: "of:def456",
          type: "application/json",
          path: ["value", "field"],
          space: "did:key:test" as any,
          meta: {},
        },
      },
    ];

    const tx = createMockTransaction(activities);
    const summary = summarizeTransaction(tx);

    assertEquals(summary.summary, "Read-only transaction");
    assertEquals(summary.activity.reads, 2);
    assertEquals(summary.activity.writes, 0);
    assertEquals(summary.changedObjects.length, 0);
    assertEquals(summary.writes.length, 0);
    assertEquals(summary.status, "done");
  });

  it("should summarize a transaction with writes (without space)", () => {
    const activities: Activity[] = [
      {
        read: {
          id: "of:abc123",
          type: "application/json",
          path: ["value"],
          space: "did:key:test" as any,
          meta: {},
        },
      },
      {
        write: {
          id: "of:abc123",
          type: "application/json",
          path: ["value", "field"],
          space: "did:key:test" as any,
        },
      },
    ];

    const tx = createMockTransaction(activities);
    const summary = summarizeTransaction(tx);

    assertEquals(summary.summary, "1 write(s) (details unavailable without space parameter)");
    assertEquals(summary.activity.reads, 1);
    assertEquals(summary.activity.writes, 1);
    assertEquals(summary.changedObjects.length, 1);
    assertEquals(summary.changedObjects[0], "of:abc123");
    assertEquals(summary.writes.length, 0); // No writes without space parameter
  });

  it("should summarize a transaction with multiple object changes", () => {
    const activities: Activity[] = [
      {
        write: {
          id: "of:abc123",
          type: "application/json",
          path: ["value"],
          space: "did:key:test" as any,
        },
      },
      {
        write: {
          id: "of:def456",
          type: "application/json",
          path: ["value"],
          space: "did:key:test" as any,
        },
      },
      {
        write: {
          id: "of:abc123", // duplicate
          type: "application/json",
          path: ["other"],
          space: "did:key:test" as any,
        },
      },
    ];

    const tx = createMockTransaction(activities);
    const summary = summarizeTransaction(tx);

    assertEquals(summary.summary, "3 write(s) (details unavailable without space parameter)");
    assertEquals(summary.activity.writes, 3);
    assertEquals(summary.changedObjects.length, 2);
  });

  it("should format transaction summary as string (without space)", () => {
    const activities: Activity[] = [
      {
        write: {
          id: "of:abc123",
          type: "application/json",
          path: ["value", "content"],
          space: "did:key:test" as any,
        },
      },
    ];

    const tx = createMockTransaction(activities);
    const formatted = formatTransactionSummary(tx);

    assertEquals(formatted.includes("pass space parameter"), true);
  });

  it("should handle empty transaction", () => {
    const tx = createMockTransaction([]);
    const summary = summarizeTransaction(tx);

    assertEquals(summary.summary, "Empty transaction");
    assertEquals(summary.activity.reads, 0);
    assertEquals(summary.activity.writes, 0);
    assertEquals(summary.changedObjects.length, 0);
    assertEquals(summary.writes.length, 0);
  });

  it("should extract detailed writes with space parameter", () => {
    const activities: Activity[] = [
      {
        write: {
          id: "of:abc123",
          type: "application/json",
          path: ["value", "content"],
          space: "did:key:test" as any,
        },
      },
    ];

    const tx = createMockTransaction(activities);
    const summary = summarizeTransaction(tx, "did:key:test" as any);

    // Summary should contain the actual write details
    assertEquals(summary.writes.length, 0); // Mock doesn't provide novelty data
    assertEquals(summary.activity.writes, 1);
  });
});

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  formatTransactionSummary,
  summarizeTransaction,
} from "../src/storage/transaction-summary.ts";
import type {
  IAttestation,
  IExtendedStorageTransaction,
  ITransactionJournal,
} from "../src/storage/interface.ts";

// Simple test transaction journal
class TestJournal implements ITransactionJournal {
  constructor(
    private noveltyData: IAttestation[] = [],
    private historyData: IAttestation[] = [],
  ) {}

  activity(): Iterable<any> {
    return [];
  }

  novelty(_space: any): Iterable<IAttestation> {
    return this.noveltyData;
  }

  history(_space: any): Iterable<IAttestation> {
    return this.historyData;
  }
}

// Helper to create test attestations
function attestation(id: string, path: string[], value?: any): IAttestation {
  return {
    address: {
      id: id as any, // Cast to URI type
      type: "application/json",
      path,
    },
    value,
  };
}

// Simple test transaction
function createTestTransaction(
  novelty: IAttestation[],
  history: IAttestation[] = [],
): IExtendedStorageTransaction {
  const journal = new TestJournal(novelty, history);
  return {
    journal,
    status: () => ({ status: "done" as const, journal }),
  } as any;
}

describe("transaction-summary", () => {
  it("should extract a single write with no previous value", () => {
    const tx = createTestTransaction([
      attestation("of:abc123", ["value", "count"], 42),
    ]);

    const summary = summarizeTransaction(tx, "did:key:test" as any);

    assertEquals(summary.writes.length, 1);
    assertEquals(summary.writes[0].path, "value.count");
    assertEquals(summary.writes[0].value, 42);
    assertEquals(summary.writes[0].previousValue, undefined);
    assertEquals(summary.writes[0].isDeleted, false);
  });

  it("should extract a write with previous value (before → after)", () => {
    const tx = createTestTransaction(
      [attestation("of:abc123", ["value", "count"], 42)],
      [attestation("of:abc123", ["value", "count"], 10)],
    );

    const summary = summarizeTransaction(tx, "did:key:test" as any);

    assertEquals(summary.writes.length, 1);
    assertEquals(summary.writes[0].value, 42);
    assertEquals(summary.writes[0].previousValue, 10);
  });

  it("should format a single new value without arrow", () => {
    const tx = createTestTransaction([
      attestation("of:abc123", ["value", "count"], 1),
    ]);

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted, "value.count = 1");
  });

  it("should format a changed value with arrow", () => {
    const tx = createTestTransaction(
      [attestation("of:abc123", ["value", "count"], 5)],
      [attestation("of:abc123", ["value", "count"], 3)],
    );

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted, "value.count: 3 → 5");
  });

  it("should group multiple writes to same object", () => {
    const tx = createTestTransaction(
      [
        attestation("of:abc123", ["value", "count"], 5),
        attestation("of:abc123", ["value", "title"], "Test"),
      ],
      [
        attestation("of:abc123", ["value", "count"], 3),
      ],
    );

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted.includes("value.count: 3 → 5"), true);
    assertEquals(formatted.includes('value.title = "Test"'), true);
  });

  it("should show object headers for multiple objects", () => {
    const tx = createTestTransaction([
      attestation("of:abc123", ["value"], 1),
      attestation("of:def456", ["value"], 2),
    ]);

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted.includes("Object abc123"), true);
    assertEquals(formatted.includes("Object def456"), true);
  });

  it("should handle deletions", () => {
    const tx = createTestTransaction(
      [attestation("of:abc123", ["value", "old"], undefined)],
      [attestation("of:abc123", ["value", "old"], "previous")],
    );

    const summary = summarizeTransaction(tx, "did:key:test" as any);

    assertEquals(summary.writes.length, 1);
    assertEquals(summary.writes[0].isDeleted, true);
  });

  it("should handle empty transaction", () => {
    const tx = createTestTransaction([]);

    const summary = summarizeTransaction(tx, "did:key:test" as any);
    assertEquals(summary.writes.length, 0);

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);
    assertEquals(formatted, "Empty transaction");
  });
});

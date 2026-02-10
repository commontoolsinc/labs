import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { refer } from "@commontools/memory/reference";
import type {
  ConfirmedRead,
  EntityId,
  JSONValue,
  Operation,
  PendingRead,
} from "@commontools/memory/v2-types";
import type { Reference } from "merkle-reference";
import {
  ClientState,
  ConfirmedState,
  type PendingCommit,
  PendingState,
} from "../src/storage/v2-client-state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTITY_A: EntityId = "urn:entity:a";
const ENTITY_B: EntityId = "urn:entity:b";
const ENTITY_C: EntityId = "urn:entity:c";

let commitCounter = 0;

/** Create a minimal PendingCommit for testing. */
function makePendingCommit(
  opts: {
    entityWrites?: [EntityId, JSONValue][];
    pendingReads?: { id: EntityId; fromCommit: string }[];
    confirmedReads?: { id: EntityId; version: number }[];
  } = {},
): PendingCommit {
  const hash = `commit-${++commitCounter}`;
  const writes = new Map<EntityId, { value?: JSONValue; hash: string }>();
  for (const [id, value] of opts.entityWrites ?? []) {
    writes.set(id, {
      value,
      hash: `hash-${id}-${commitCounter}`,
    });
  }

  const pendingReads: PendingRead[] = (opts.pendingReads ?? []).map((r) => ({
    id: r.id,
    hash: refer({ test: r.id }) as unknown as Reference,
    fromCommit: refer({ commit: r.fromCommit }) as unknown as Reference,
  }));

  const confirmedReads: ConfirmedRead[] = (opts.confirmedReads ?? []).map(
    (r) => ({
      id: r.id,
      hash: refer({ test: r.id }) as unknown as Reference,
      version: r.version,
    }),
  );

  return {
    hash,
    operations: [] as Operation[],
    reads: {
      confirmed: confirmedReads,
      pending: pendingReads,
    },
    writes,
  };
}

/**
 * Create a PendingCommit with a pending read that uses the actual commit hash
 * string (for matching in the cascade rejection logic which uses
 * fromCommit.toString()).
 */
function makePendingCommitWithRawPendingRead(
  opts: {
    entityWrites?: [EntityId, JSONValue][];
    rawPendingReads?: { id: EntityId; fromCommitHash: string }[];
  } = {},
): PendingCommit {
  const hash = `commit-${++commitCounter}`;
  const writes = new Map<EntityId, { value?: JSONValue; hash: string }>();
  for (const [id, value] of opts.entityWrites ?? []) {
    writes.set(id, {
      value,
      hash: `hash-${id}-${commitCounter}`,
    });
  }

  // Build PendingRead objects whose fromCommit.toString() returns the raw
  // hash string directly, so cascade matching works with our simple string
  // commit hashes.
  const pendingReads: PendingRead[] = (opts.rawPendingReads ?? []).map((r) => ({
    id: r.id,
    hash: refer({ test: r.id }) as unknown as Reference,
    fromCommit: {
      toString: () => r.fromCommitHash,
    } as unknown as Reference,
  }));

  return {
    hash,
    operations: [] as Operation[],
    reads: {
      confirmed: [],
      pending: pendingReads,
    },
    writes,
  };
}

// ---------------------------------------------------------------------------
// ConfirmedState
// ---------------------------------------------------------------------------

describe("ConfirmedState", () => {
  it("set/get/has", () => {
    const state = new ConfirmedState();
    expect(state.has(ENTITY_A)).toBe(false);
    expect(state.get(ENTITY_A)).toBeUndefined();

    state.set(ENTITY_A, { version: 1, hash: "h1", value: 42 });
    expect(state.has(ENTITY_A)).toBe(true);
    expect(state.get(ENTITY_A)).toEqual({ version: 1, hash: "h1", value: 42 });
  });

  it("delete", () => {
    const state = new ConfirmedState();
    state.set(ENTITY_A, { version: 1, hash: "h1", value: "x" });
    state.delete(ENTITY_A);
    expect(state.has(ENTITY_A)).toBe(false);
    expect(state.get(ENTITY_A)).toBeUndefined();
  });

  it("getAll returns all entries", () => {
    const state = new ConfirmedState();
    state.set(ENTITY_A, { version: 1, hash: "h1", value: "a" });
    state.set(ENTITY_B, { version: 2, hash: "h2", value: "b" });

    const all = state.getAll();
    expect(all.size).toBe(2);
    expect(all.get(ENTITY_A)).toEqual({ version: 1, hash: "h1", value: "a" });
    expect(all.get(ENTITY_B)).toEqual({ version: 2, hash: "h2", value: "b" });
  });

  it("clear removes all entries", () => {
    const state = new ConfirmedState();
    state.set(ENTITY_A, { version: 1, hash: "h1" });
    state.set(ENTITY_B, { version: 2, hash: "h2" });
    state.clear();
    expect(state.getAll().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PendingState
// ---------------------------------------------------------------------------

describe("PendingState", () => {
  it("push and get entity value", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, "hello"]],
    });
    pending.push(c1);

    const result = pending.get(ENTITY_A);
    expect(result).toBeDefined();
    expect(result!.value).toBe("hello");
    expect(result!.fromCommit).toBe(c1.hash);
  });

  it("newest commit wins when reading", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, "first"]],
    });
    const c2 = makePendingCommit({
      entityWrites: [[ENTITY_A, "second"]],
    });
    pending.push(c1);
    pending.push(c2);

    const result = pending.get(ENTITY_A);
    expect(result!.value).toBe("second");
    expect(result!.fromCommit).toBe(c2.hash);
  });

  it("get returns undefined for unknown entity", () => {
    const pending = new PendingState();
    expect(pending.get(ENTITY_A)).toBeUndefined();
  });

  it("remove by hash", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, 1]],
    });
    const c2 = makePendingCommit({
      entityWrites: [[ENTITY_B, 2]],
    });
    pending.push(c1);
    pending.push(c2);

    const removed = pending.remove(c1.hash);
    expect(removed).toBeDefined();
    expect(removed!.hash).toBe(c1.hash);
    expect(pending.length).toBe(1);
    expect(pending.get(ENTITY_A)).toBeUndefined();
    expect(pending.get(ENTITY_B)).toBeDefined();
  });

  it("remove returns undefined for unknown hash", () => {
    const pending = new PendingState();
    expect(pending.remove("nonexistent")).toBeUndefined();
  });

  it("simple rejection", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, 1]],
    });
    pending.push(c1);

    const rejected = pending.reject(c1.hash);
    expect(rejected.length).toBe(1);
    expect(rejected[0].hash).toBe(c1.hash);
    expect(pending.length).toBe(0);
  });

  it("cascade rejection: C2 depends on C1", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, "v1"]],
    });
    // C2 reads from C1
    const c2 = makePendingCommitWithRawPendingRead({
      entityWrites: [[ENTITY_B, "v2"]],
      rawPendingReads: [{ id: ENTITY_A, fromCommitHash: c1.hash }],
    });
    pending.push(c1);
    pending.push(c2);

    const rejected = pending.reject(c1.hash);
    expect(rejected.length).toBe(2);
    expect(rejected.map((c) => c.hash)).toContain(c1.hash);
    expect(rejected.map((c) => c.hash)).toContain(c2.hash);
    expect(pending.length).toBe(0);
  });

  it("deep cascade: C1 -> C2 -> C3, reject C1 rejects all", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, "v1"]],
    });
    const c2 = makePendingCommitWithRawPendingRead({
      entityWrites: [[ENTITY_B, "v2"]],
      rawPendingReads: [{ id: ENTITY_A, fromCommitHash: c1.hash }],
    });
    const c3 = makePendingCommitWithRawPendingRead({
      entityWrites: [[ENTITY_C, "v3"]],
      rawPendingReads: [{ id: ENTITY_B, fromCommitHash: c2.hash }],
    });
    pending.push(c1);
    pending.push(c2);
    pending.push(c3);

    const rejected = pending.reject(c1.hash);
    expect(rejected.length).toBe(3);
    expect(pending.length).toBe(0);
  });

  it("rejection does not affect independent commits", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, "v1"]],
    });
    const c2 = makePendingCommit({
      entityWrites: [[ENTITY_B, "v2"]],
    });
    pending.push(c1);
    pending.push(c2);

    const rejected = pending.reject(c1.hash);
    expect(rejected.length).toBe(1);
    expect(rejected[0].hash).toBe(c1.hash);
    expect(pending.length).toBe(1);
    expect(pending.get(ENTITY_B)!.value).toBe("v2");
  });

  it("find by hash", () => {
    const pending = new PendingState();
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, 1]],
    });
    pending.push(c1);

    expect(pending.find(c1.hash)).toBe(c1);
    expect(pending.find("nonexistent")).toBeUndefined();
  });

  it("clear removes all commits", () => {
    const pending = new PendingState();
    pending.push(makePendingCommit({ entityWrites: [[ENTITY_A, 1]] }));
    pending.push(makePendingCommit({ entityWrites: [[ENTITY_B, 2]] }));
    pending.clear();
    expect(pending.length).toBe(0);
    expect(pending.getAll().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ClientState
// ---------------------------------------------------------------------------

describe("ClientState", () => {
  it("read: pending wins over confirmed", () => {
    const state = new ClientState();
    state.confirmed.set(ENTITY_A, { version: 1, hash: "h1", value: "old" });

    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, "new"]],
    });
    state.pending.push(c1);

    const result = state.read(ENTITY_A);
    expect(result).toEqual({ value: "new", source: "pending" });
  });

  it("read: confirmed used when no pending", () => {
    const state = new ClientState();
    state.confirmed.set(ENTITY_A, {
      version: 5,
      hash: "h5",
      value: "confirmed-val",
    });

    const result = state.read(ENTITY_A);
    expect(result).toEqual({ value: "confirmed-val", source: "confirmed" });
  });

  it("read: returns undefined for unknown entity", () => {
    const state = new ClientState();
    expect(state.read(ENTITY_A)).toBeUndefined();
  });

  it("confirm: promotes pending to confirmed", () => {
    const state = new ClientState();
    const c1 = makePendingCommit({
      entityWrites: [
        [ENTITY_A, "val-a"],
        [ENTITY_B, "val-b"],
      ],
    });
    state.pending.push(c1);

    const confirmed = state.confirm(c1.hash, 10);
    expect(confirmed).toBeDefined();
    expect(confirmed!.hash).toBe(c1.hash);

    // Pending should be empty
    expect(state.pending.length).toBe(0);

    // Confirmed should have the values
    const entryA = state.confirmed.get(ENTITY_A);
    expect(entryA!.version).toBe(10);
    expect(entryA!.value).toBe("val-a");

    const entryB = state.confirmed.get(ENTITY_B);
    expect(entryB!.version).toBe(10);
    expect(entryB!.value).toBe("val-b");

    // Read should now resolve from confirmed
    const readA = state.read(ENTITY_A);
    expect(readA).toEqual({ value: "val-a", source: "confirmed" });
  });

  it("confirm: returns undefined for unknown commit", () => {
    const state = new ClientState();
    expect(state.confirm("nonexistent", 1)).toBeUndefined();
  });

  it("reject: cascade rejects dependents, confirmed unaffected", () => {
    const state = new ClientState();

    // Set up confirmed state
    state.confirmed.set(ENTITY_C, {
      version: 1,
      hash: "hc",
      value: "confirmed-c",
    });

    // C1 writes to A
    const c1 = makePendingCommit({
      entityWrites: [[ENTITY_A, "pending-a"]],
    });
    // C2 depends on C1
    const c2 = makePendingCommitWithRawPendingRead({
      entityWrites: [[ENTITY_B, "pending-b"]],
      rawPendingReads: [{ id: ENTITY_A, fromCommitHash: c1.hash }],
    });
    state.pending.push(c1);
    state.pending.push(c2);

    const rejected = state.reject(c1.hash);
    expect(rejected.length).toBe(2);

    // Pending should be empty
    expect(state.pending.length).toBe(0);

    // Confirmed state should be unaffected
    expect(state.confirmed.get(ENTITY_C)!.value).toBe("confirmed-c");

    // Previously pending entities should now be undefined
    expect(state.read(ENTITY_A)).toBeUndefined();
    expect(state.read(ENTITY_B)).toBeUndefined();

    // Confirmed entity should still be readable
    expect(state.read(ENTITY_C)).toEqual({
      value: "confirmed-c",
      source: "confirmed",
    });
  });

  it("clear: removes all state", () => {
    const state = new ClientState();
    state.confirmed.set(ENTITY_A, { version: 1, hash: "h1", value: "x" });
    state.pending.push(
      makePendingCommit({ entityWrites: [[ENTITY_B, "y"]] }),
    );

    state.clear();
    expect(state.read(ENTITY_A)).toBeUndefined();
    expect(state.read(ENTITY_B)).toBeUndefined();
    expect(state.confirmed.getAll().size).toBe(0);
    expect(state.pending.length).toBe(0);
  });
});

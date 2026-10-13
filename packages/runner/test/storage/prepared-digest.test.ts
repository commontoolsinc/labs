import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import type { SqliteDbRef } from "@commonfabric/memory/v2";

import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  ExtendedStorageTransaction,
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../../src/storage/extended-storage-transaction.ts";
import { Runtime } from "../../src/runtime.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("prepared-digest-test");
const address = (id: string) => ({
  space: signer.did(),
  scope: "space" as const,
  id: `of:${id}` as const,
  path: [],
});

describe("prepared digest transaction binding", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
  });
  afterEach(async () => {
    await runtime.dispose();
  });

  it("does not report a write when the storage operation rejects it", () => {
    const operations = [
      (tx: ExtendedStorageTransaction) =>
        tx.write(address("rejected"), 1).error,
      (tx: ExtendedStorageTransaction) =>
        tx.writeValueOrThrow(address("rejected"), 1),
      (tx: ExtendedStorageTransaction) =>
        tx.writeValuesOrThrow([{ address: address("rejected"), value: 1 }]),
      (tx: ExtendedStorageTransaction) =>
        tx.recordSqliteWrite(signer.did(), {
          op: "sqlite",
          db: { id: "of:test", tables: {} },
          sql: "CREATE TABLE notes (body TEXT)",
          params: [],
        }),
      (tx: ExtendedStorageTransaction) =>
        tx.recordMergeableOp(address("rejected"), { op: "increment", by: 1 }),
    ];
    for (const operation of operations) {
      const outcomes: string[] = [];
      const underlying = runtime.edit() as ExtendedStorageTransaction;
      const tx = new ExtendedStorageTransaction(underlying.tx, {
        onPreparedDigest: (outcome) => outcomes.push(outcome),
      });
      tx.abort();
      tx.accessForTestingOnly.preparedDigest();
      let error: unknown;
      try {
        error = operation(tx);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(tx.hasWrites()).toBe(false);
      tx.accessForTestingOnly.preparedDigest();
      expect(outcomes).toEqual(["computed", "computed"]);
    }
  });

  it("reports successful writes but leaves an empty batch read-only", () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    try {
      tx.writeValuesOrThrow([]);
      expect(tx.hasWrites()).toBe(false);
      tx.writeValuesOrThrow([{ address: address("output"), value: 1 }]);
      expect(tx.hasWrites()).toBe(true);
    } finally {
      tx.abort();
    }
  });

  it("reuses the prepared digest at commit with no intervening activity", async () => {
    const outcomes: string[] = [];
    const underlying = runtime.edit() as ExtendedStorageTransaction;
    const tx = new ExtendedStorageTransaction(underlying.tx, {
      onPreparedDigest: (outcome) => outcomes.push(outcome),
    });
    tx.writeValueOrThrow(address("output"), 1);
    expect(tx.prepareCfc()).not.toBe("");
    expect(outcomes).toEqual(["computed"]);
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(outcomes).toEqual(["computed", "memo"]);
  });

  it("recomputes after a repeated trace while preserving the prepared token", async () => {
    const outcomes: string[] = [];
    const underlying = runtime.edit() as ExtendedStorageTransaction;
    const tx = new ExtendedStorageTransaction(underlying.tx, {
      onPreparedDigest: (outcome) => outcomes.push(outcome),
    });
    const trace = {
      source: address("a"),
      target: address("b"),
      kind: "value" as const,
    };
    tx.recordCfcDereferenceTrace(trace);
    expect(tx.prepareCfc()).not.toBe("");
    tx.recordCfcDereferenceTrace({ ...trace });
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(outcomes).toEqual(["computed", "computed"]);
  });

  it("binds the same activity independently of policy and trace insertion order", () => {
    const digest = (reverse: boolean, value = "same") => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow(address("output"), value);
        tx.readValueOrThrow(address("output"));
        const ids = reverse ? ["b", "a"] : ["a", "b"];
        for (const id of ids) {
          tx.recordCfcWritePolicyInput({
            kind: "custom",
            target: address(id),
            name: "p",
            value,
          });
          tx.recordCfcDereferenceTrace({
            source: address(id),
            target: address("c"),
            kind: "value",
          });
        }
        return tx.accessForTestingOnly.preparedDigest();
      } finally {
        tx.abort();
      }
    };
    expect(digest(false)).toBe(digest(true));
    expect(digest(false)).not.toBe(digest(true, "different"));
  });

  it("binds each whole-value root and the identity that recorded it", () => {
    // A recorded root decides where prepare stamps the writer's flow label
    // (`assertedValueRootPaths`), so two transactions that differ only in
    // their roots must not share a digest, nor one whose root was recorded
    // under a different identity.
    const writer = (symbol: string) => ({
      kind: "verified" as const,
      moduleIdentity: "module:digest",
      symbol,
      bindingPath: [symbol],
    });
    const digest = (roots: readonly { path: string[]; by: string }[]) => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow({ ...address("output"), path: ["a", "b"] }, 1);
        for (const root of roots) {
          setCfcImplementationIdentity(tx, writer(root.by));
          tx.recordCfcAssertedValueRoot(
            { ...address("output"), path: root.path },
            runtimeWritePolicyAuthorization,
          );
        }
        setCfcImplementationIdentity(tx, writer("commit"));
        return tx.accessForTestingOnly.preparedDigest();
      } finally {
        tx.abort();
      }
    };
    const none = digest([]);
    const atA = digest([{ path: ["a"], by: "commit" }]);
    expect(atA).not.toBe(none);
    expect(digest([{ path: [], by: "commit" }])).not.toBe(atA);
    expect(digest([{ path: ["a"], by: "other" }])).not.toBe(atA);
    expect(digest([{ path: ["a"], by: "commit" }])).toBe(atA);
    // The roots are a set: recording order is not digest content.
    const two = digest([
      { path: ["a"], by: "commit" },
      { path: [], by: "commit" },
    ]);
    expect(
      digest([{ path: [], by: "commit" }, { path: ["a"], by: "commit" }]),
    ).toBe(two);
    expect(two).not.toBe(atA);
    // Paths that differ only in a leading `value` are distinct roots.
    const shallow = digest([{ path: ["value", "a"], by: "commit" }]);
    const deep = digest([{ path: ["value", "value", "a"], by: "commit" }]);
    const both = digest([
      { path: ["value", "a"], by: "commit" },
      { path: ["value", "value", "a"], by: "commit" },
    ]);
    expect(both).not.toBe(shallow);
    expect(both).not.toBe(deep);
    // Recorded twice, a root stamps once, and the digest says the same.
    expect(
      digest([{ path: ["a"], by: "commit" }, { path: ["a"], by: "commit" }]),
    ).toBe(atA);
  });

  it("retires the memo when a whole-value root or structure container is recorded", () => {
    // Both decide where preparation stamps the flow label, so recording one
    // after a digest was taken must not leave the memoized digest standing.
    const recorders = [
      (tx: ExtendedStorageTransaction) =>
        tx.recordCfcAssertedValueRoot(
          { ...address("output"), path: ["a"] },
          runtimeWritePolicyAuthorization,
        ),
      (tx: ExtendedStorageTransaction) =>
        tx.recordCfcStructureContainer({ ...address("output"), path: ["a"] }),
    ];
    for (const record of recorders) {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow({ ...address("output"), path: ["a", "b"] }, 1);
        const before = tx.accessForTestingOnly.preparedDigest();
        record(tx);
        expect(tx.accessForTestingOnly.preparedDigest()).not.toBe(before);
      } finally {
        tx.abort();
      }
    }
  });

  it("binds structure containers whose paths differ only in a leading value", () => {
    // `["value", "x"]` and `["value", "value", "x"]` are distinct paths once
    // canonicalized (`["x"]` and `["value", "x"]`), so both containers are
    // digest content, and the pair differs from either alone.
    const digest = (paths: string[][]) => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      try {
        tx.writeValueOrThrow({ ...address("output"), path: ["x"] }, 1);
        for (const path of paths) {
          tx.recordCfcStructureContainer({ ...address("output"), path });
        }
        return tx.accessForTestingOnly.preparedDigest();
      } finally {
        tx.abort();
      }
    };
    const shallow = digest([["value", "x"]]);
    const deep = digest([["value", "value", "x"]]);
    const both = digest([["value", "x"], ["value", "value", "x"]]);
    expect(deep).not.toBe(shallow);
    expect(both).not.toBe(shallow);
    expect(both).not.toBe(deep);
    expect(digest([["value", "value", "x"], ["value", "x"]])).toBe(both);
  });

  it("retires the memo for writes and policy records before preparation", () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    try {
      const access = tx.accessForTestingOnly;
      const empty = access.preparedDigest();
      tx.writeValueOrThrow(address("output"), "one");
      const written = access.preparedDigest();
      expect(written).not.toBe(empty);
      tx.recordCfcWritePolicyInput({ kind: "custom", name: "p", value: "two" });
      expect(access.preparedDigest()).not.toBe(written);
    } finally {
      tx.abort();
    }
  });

  it("rejects a prepared transaction after a batched write", async () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    tx.writeValueOrThrow(address("output"), "one");
    tx.markCfcRelevant("test");
    expect(tx.prepareCfc()).not.toBe("");
    tx.writeValuesOrThrow([{ address: address("output"), value: "two" }]);
    expect((await tx.commit().settled).error).toBeDefined();
  });

  describe("a write after a preparation", () => {
    // Each case but the first writes once more after the preparation,
    // through a path that leaves nothing in the prepared digest's input: the
    // storage layer elides a write of the value already there and a delete
    // that finds nothing, and holds a SQLite write and a mergeable op outside
    // the journal. Comparing digests at commit cannot refuse any of them, so
    // each has to invalidate the preparation where it happens.

    const prepared = (value: number) => {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      tx.writeValueOrThrow(address("output"), value);
      tx.markCfcRelevant("test");
      expect(tx.prepareCfc()).not.toBe("");
      return tx;
    };

    const expectInvalidated = async (
      tx: ExtendedStorageTransaction,
      reason: string,
    ) => {
      const state = tx.getCfcState().prepare;
      expect(state.status).toBe("invalidated");
      expect(state.status === "invalidated" && state.reasons).toEqual([reason]);
      const { error } = await tx.commit().settled;
      expect(error?.name).toBe("StorageTransactionAborted");
    };

    it("leaves the transaction prepared, and commits it, after an empty batch", async () => {
      const tx = prepared(1);
      tx.writeValuesOrThrow([]);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect((await tx.commit().settled).error).toBeUndefined();
    });

    it("invalidates the preparation and fails the commit after a batched write of the value already written", async () => {
      const tx = prepared(1);
      tx.writeValuesOrThrow([{ address: address("output"), value: 1 }]);
      await expectInvalidated(tx, "write-after-prepare");
    });

    it("invalidates the preparation and fails the commit after a batched delete of an absent document", async () => {
      const tx = prepared(1);
      tx.writeValuesOrThrow([
        { address: address("absent"), value: undefined, delete: true },
      ]);
      await expectInvalidated(tx, "write-after-prepare");
    });

    it("invalidates the preparation and fails the commit after a single write of the value already written", async () => {
      const tx = prepared(1);
      tx.writeValueOrThrow(address("output"), 1);
      await expectInvalidated(tx, "write-after-prepare");
    });

    it("invalidates the preparation and fails the commit after a recorded SQLite write, and stores no row", async () => {
      const db: SqliteDbRef = {
        id: `of:prepared-digest-${crypto.randomUUID()}`,
        tables: { notes: table({ id: "integer primary key", body: "text" }) },
      };
      const tx = prepared(1);
      tx.recordSqliteWrite(signer.did(), {
        op: "sqlite",
        db,
        sql: "INSERT INTO notes (body) VALUES (?)",
        params: ["after"],
      });
      await expectInvalidated(tx, "sqlite-write-after-prepare");
      const stored = await storage.open(signer.did()).sqliteQuery!(
        db,
        "SELECT body FROM notes",
      );
      expect(stored.rows).toEqual([]);
    });

    it("invalidates the preparation and fails the commit after a recorded mergeable op, and stores no value", async () => {
      const tx = prepared(5);
      tx.recordMergeableOp(address("output"), { op: "increment", by: 2 });
      await expectInvalidated(tx, "mergeable-op-after-prepare");
      const after = runtime.edit() as ExtendedStorageTransaction;
      try {
        expect(after.readValueOrThrow(address("output"))).toBeUndefined();
      } finally {
        after.abort();
      }
    });
  });

  it("fails the commit on a digest mismatch when module delegations are set after a preparation", async () => {
    // Setting the delegations moves the activity epoch without invalidating
    // the preparation, and the digest binds them, so the transaction reaches
    // the comparison at commit still prepared, with a digest that differs.
    const underlying = runtime.edit() as ExtendedStorageTransaction;
    const tx = new ExtendedStorageTransaction(underlying.tx);
    tx.setCfcEnforcementMode("enforce-strict");
    tx.writeValueOrThrow(address("output"), "one");
    tx.markCfcRelevant("test");
    expect(tx.prepareCfc()).not.toBe("");
    tx.setCfcModuleDelegations(
      new Map([[signer.did(), new Map([["module-a", ["module-b"]]])]]),
    );
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    const { error } = await tx.commit().settled;
    expect(error?.name).toBe("StorageTransactionAborted");
    expect((error as { reason?: Error }).reason?.message).toBe(
      "cfc-prepared-digest-mismatch",
    );
  });

  it("holds trust and implementation snapshots immutable", () => {
    const tx = runtime.edit() as ExtendedStorageTransaction;
    try {
      const trust = { id: "trust", revision: "1" };
      const identity = { kind: "verified" as const, bindingPath: ["one"] };
      setCfcTrustSnapshot(tx, trust);
      setCfcImplementationIdentity(tx, identity);
      const digest = tx.accessForTestingOnly.preparedDigest();
      expect(() => {
        trust.revision = "2";
      }).toThrow(TypeError);
      expect(() => {
        identity.bindingPath.push("two");
      }).toThrow(TypeError);
      expect(tx.accessForTestingOnly.preparedDigest()).toBe(digest);
      setCfcTrustSnapshot(tx, { id: "trust", revision: "2" });
      expect(tx.accessForTestingOnly.preparedDigest()).not.toBe(digest);
    } finally {
      tx.abort();
    }
  });
});

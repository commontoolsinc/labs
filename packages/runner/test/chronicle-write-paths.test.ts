import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ISpaceReplica } from "../src/storage/interface.ts";
import * as Chronicle from "../src/storage/transaction/chronicle.ts";

const signer = await Identity.fromPassphrase("chronicle-write-paths");
const space = signer.did();

const seedDoc = async (
  storage: ReturnType<typeof StorageManager.emulate>,
  id: `${string}:${string}`,
  value: unknown,
) => {
  const replica = storage.open(space).replica;
  if (!replica.commitNative) {
    throw new Error("Expected memory v2 replica to support commitNative()");
  }
  await replica.commitNative({
    operations: [{
      op: "set",
      id,
      type: "application/json",
      // deno-lint-ignore no-explicit-any
      value: value as any,
    }],
  });
  return replica;
};

describe("Chronicle write paths", () => {
  it(
    "writes at a nested path inside an existing document",
    async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const id = "test:chronicle-nested-write" as const;
        const replica = await seedDoc(storage, id, {
          value: { profile: { name: "Ada", visits: 1 } },
        });

        const chronicle = Chronicle.open(replica);
        const result = chronicle.write({
          id,
          type: "application/json",
          path: ["value", "profile", "visits"],
        }, 2);

        expect(result.error).toBeUndefined();
        expect(result.ok?.value).toEqual({
          value: { profile: { name: "Ada", visits: 2 } },
        });

        // The novelty entry should reflect the new value.
        const read = chronicle.read({
          id,
          type: "application/json",
          path: ["value", "profile", "visits"],
        });
        expect(read.ok?.value).toBe(2);
      } finally {
        await storage.close();
      }
    },
  );

  it(
    "auto-creates missing intermediate containers on a nested write into an existing doc " +
      "(post-#3708 behavior shift; the old setAtPath returned NotFound for this case)",
    async () => {
      const storage = StorageManager.emulate({ as: signer });
      try {
        const id = "test:chronicle-create-parents" as const;
        const replica = await seedDoc(storage, id, {
          value: { existing: "kept" },
        });

        const chronicle = Chronicle.open(replica);
        const result = chronicle.write({
          id,
          type: "application/json",
          path: ["value", "details", "profile", "name"],
        }, "Ada");

        expect(result.error).toBeUndefined();
        expect(result.ok?.value).toEqual({
          value: {
            existing: "kept",
            details: { profile: { name: "Ada" } },
          },
        });

        // Existing sibling at /value/existing is preserved.
        const readSibling = chronicle.read({
          id,
          type: "application/json",
          path: ["value", "existing"],
        });
        expect(readSibling.ok?.value).toBe("kept");
      } finally {
        await storage.close();
      }
    },
  );

  it("returns TypeMismatchError when writing through a primitive intermediate", async () => {
    const storage = StorageManager.emulate({ as: signer });
    try {
      const id = "test:chronicle-type-mismatch" as const;
      const replica = await seedDoc(storage, id, {
        value: { name: "Ada" },
      });

      const chronicle = Chronicle.open(replica);
      const result = chronicle.write({
        id,
        type: "application/json",
        path: ["value", "name", "deeper"],
      }, "should fail");

      expect(result.error?.name).toBe("TypeMismatchError");
      // Error path points at the offending non-container intermediate
      // (`name`, which is a string), not at the leaf we tried to write.
      expect(result.error?.address?.path).toEqual(["value", "name"]);
    } finally {
      await storage.close();
    }
  });

  it("does not elide a root rewrite of `0` with `-0`", async () => {
    // `0` and `-0` are distinct stored values (`valueEqual` and the content
    // hash both distinguish them), so a `-0` root write over a `0` working
    // copy must not be dropped as a no-op.
    const storage = StorageManager.emulate({ as: signer });
    try {
      const id = "test:chronicle-negative-zero-root" as const;
      const replica = storage.open(space).replica;
      const address = { id, type: "application/json" as const, path: [] };

      const chronicle = Chronicle.open(replica);
      expect(chronicle.write(address, 0).error).toBeUndefined();
      expect(chronicle.write(address, -0).error).toBeUndefined();

      const read = chronicle.read(address);
      expect(read.error).toBeUndefined();
      expect(Object.is(read.ok?.value, -0)).toBe(true);
    } finally {
      await storage.close();
    }
  });

  it("commits a primitive root change from `0` to `-0` as an assertion, not a no-change claim", () => {
    // A memory v2 replica only stores explicit full-document (record) roots,
    // so the primitive-root contract is pinned with a minimal replica stub:
    // the loaded root is `0`, and the transaction writes `-0` over it. The
    // distinction matters because `valueEqual` and the content hash both
    // treat `0` and `-0` as different stored values.
    const id = "test:chronicle-negative-zero-commit" as const;
    const replica = {
      did: () => space,
      get: () => ({ the: "application/json", of: id, is: 0 }),
    } as unknown as ISpaceReplica;

    const chronicle = Chronicle.open(replica);
    const result = chronicle.write(
      { id, type: "application/json", path: [] },
      -0,
    );
    expect(result.error).toBeUndefined();

    const commitResult = chronicle.commit();
    expect(commitResult.error).toBeUndefined();
    const fact = commitResult.ok!.facts.find((f) => f.of === id);
    expect(fact).toBeDefined();
    expect(Object.is(fact!.is, -0)).toBe(true);
  });

  it("treats a write of the same value as a no-op (identity returned)", async () => {
    const storage = StorageManager.emulate({ as: signer });
    try {
      const id = "test:chronicle-noop" as const;
      const replica = await seedDoc(storage, id, {
        value: { count: 1 },
      });

      const chronicle = Chronicle.open(replica);
      // First write to materialize the working copy.
      const first = chronicle.write({
        id,
        type: "application/json",
        path: ["value", "count"],
      }, 1);
      expect(first.error).toBeUndefined();
      const firstSnapshot = first.ok;

      // Second write with the same value -- working copy should be unchanged.
      const second = chronicle.write({
        id,
        type: "application/json",
        path: ["value", "count"],
      }, 1);
      expect(second.error).toBeUndefined();
      expect(second.ok).toBe(firstSnapshot);
    } finally {
      await storage.close();
    }
  });
});

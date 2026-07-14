import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import { StorageManager } from "../src/storage/cache.deno.ts";
import * as Chronicle from "../src/storage/transaction/chronicle.ts";

const signer = await Identity.fromPassphrase("chronicle-write-paths");
const space = signer.did();

const seedDoc = async (
  storage: ReturnType<typeof StorageManager.emulate>,
  id: `${string}:${string}`,
  value: FabricValue,
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
      value,
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

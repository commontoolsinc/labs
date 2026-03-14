import { assert, assertEquals, assertExists } from "@std/assert";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  NativeStorageCommit,
  Result,
  StorageTransactionRejected,
  Unit,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("memory-v2-native-commit");
const space = signer.did();
const type = "application/json" as const;

Deno.test("memory v2 transactions use the native commit hook when available", async () => {
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });

  try {
    const provider = storage.open(space);
    const replica = provider.replica as typeof provider.replica & {
      commitNative(
        transaction: NativeStorageCommit,
        source?: unknown,
      ): Promise<Result<Unit, StorageTransactionRejected>>;
      commit(
        transaction: unknown,
        source?: unknown,
      ): Promise<Result<Unit, StorageTransactionRejected>>;
    };
    const originalCommitNative = replica.commitNative?.bind(replica);
    assertExists(originalCommitNative);

    const drafts: NativeStorageCommit[] = [];
    replica.commit = () =>
      Promise.reject(new Error("legacy commit path should not be used"));
    replica.commitNative = async (transaction, source) => {
      drafts.push(transaction);
      return await originalCommitNative(transaction, source);
    };

    const tx = storage.edit();
    const writeResult = tx.write({
      space,
      id: "of:memory-v2-native-commit",
      type,
      path: [],
    }, { value: { count: 1 } });
    assert(writeResult.ok);

    const commitResult = await tx.commit();
    assert(commitResult.ok);
    assertEquals(drafts, [{
      operations: [{
        id: "of:memory-v2-native-commit",
        type,
        value: { value: { count: 1 } },
      }],
    }]);

    const verify = storage.edit();
    const readResult = verify.read({
      space,
      id: "of:memory-v2-native-commit",
      type,
      path: ["value"],
    });
    assertEquals(readResult.ok?.value, { count: 1 });
  } finally {
    await storage.close();
  }
});

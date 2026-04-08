import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import * as Chronicle from "../src/storage/transaction/chronicle.ts";

const signer = await Identity.fromPassphrase("memory v2 envelope delete");
const space = signer.did();

Deno.test("memory v2 chronicle retracts an empty JSON envelope", async () => {
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });

  try {
    const replica = storage.open(space).replica;
    if (!replica.commitNative) {
      throw new Error("Expected memory v2 replica to support commitNative()");
    }
    await replica.commitNative({
      operations: [{
        op: "set",
        id: "test:delete-envelope",
        type: "application/json",
        value: { value: { name: "ToDelete", active: true } },
      }],
    });

    const chronicle = Chronicle.open(replica);
    chronicle.write({
      id: "test:delete-envelope",
      type: "application/json",
      path: ["value"],
    }, undefined);

    const commitResult = chronicle.commit();
    const transaction = commitResult.ok!;

    assertEquals(commitResult.error, undefined);
    assertEquals(transaction.facts.length, 1);
    assertEquals(transaction.facts[0].of, "test:delete-envelope");
    assertEquals(transaction.facts[0].is, undefined);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 chronicle treats an explicit empty root envelope as deletion", async () => {
  const storage = StorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });

  try {
    const replica = storage.open(space).replica;
    if (!replica.commitNative) {
      throw new Error("Expected memory v2 replica to support commitNative()");
    }
    await replica.commitNative({
      operations: [{
        op: "set",
        id: "test:keep-empty-object",
        type: "application/json",
        value: { value: { value: "hello", other: true } },
      }],
    });

    const chronicle = Chronicle.open(replica);
    chronicle.write({
      id: "test:keep-empty-object",
      type: "application/json",
      path: [],
    }, {});

    const commitResult = chronicle.commit();
    const transaction = commitResult.ok!;

    assertEquals(commitResult.error, undefined);
    assertEquals(transaction.facts.length, 1);
    assertEquals(transaction.facts[0].of, "test:keep-empty-object");
    assertEquals(transaction.facts[0].is, undefined);
  } finally {
    await storage.close();
  }
});

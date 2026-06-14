import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import * as Chronicle from "../src/storage/transaction/chronicle.ts";

const signer = await Identity.fromPassphrase("memory v2 envelope delete");
const space = signer.did();

Deno.test("memory v2 chronicle retracts when the envelope value is deleted", async () => {
  const storage = StorageManager.emulate({
    as: signer,
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
    // Explicit delete of the envelope's `value` key empties the envelope,
    // which commits as a retraction.
    chronicle.write(
      {
        id: "test:delete-envelope",
        type: "application/json",
        path: ["value"],
      },
      undefined,
      { delete: true },
    );

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

Deno.test("memory v2 chronicle preserves an envelope whose value is written as undefined", async () => {
  const storage = StorageManager.emulate({
    as: signer,
  });

  try {
    const replica = storage.open(space).replica;
    if (!replica.commitNative) {
      throw new Error("Expected memory v2 replica to support commitNative()");
    }
    await replica.commitNative({
      operations: [{
        op: "set",
        id: "test:set-undefined-envelope",
        type: "application/json",
        value: { value: { name: "ToClear", active: true } },
      }],
    });

    const chronicle = Chronicle.open(replica);
    // A plain write of `undefined` stores `undefined` as the envelope value;
    // the fact stays asserted (present-but-undefined, not retracted).
    chronicle.write({
      id: "test:set-undefined-envelope",
      type: "application/json",
      path: ["value"],
    }, undefined);

    const commitResult = chronicle.commit();
    const transaction = commitResult.ok!;

    assertEquals(commitResult.error, undefined);
    assertEquals(transaction.facts.length, 1);
    assertEquals(transaction.facts[0].of, "test:set-undefined-envelope");
    const is = transaction.facts[0].is as
      | Record<string, unknown>
      | undefined;
    assertEquals(is !== undefined, true);
    assertEquals(Object.hasOwn(is!, "value"), true);
    assertEquals(is!.value, undefined);
  } finally {
    await storage.close();
  }
});

Deno.test("memory v2 chronicle treats an explicit empty root envelope as deletion", async () => {
  const storage = StorageManager.emulate({
    as: signer,
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

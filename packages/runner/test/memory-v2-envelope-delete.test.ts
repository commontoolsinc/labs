import { assertEquals } from "@std/assert";
import { assert } from "@commontools/memory/fact";
import { Identity } from "@commontools/identity";
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
    await replica.commit({
      facts: [
        assert({
          the: "application/json",
          of: "test:delete-envelope",
          is: { value: { name: "ToDelete", active: true } },
        }),
      ],
      claims: [],
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

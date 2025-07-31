#!/usr/bin/env -S deno run -A

import { deepEqual, Runtime } from "@commontools/runner";
import { Identity, IdentityCreateConfig } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type JSONSchema } from "@commontools/runner";
import { env } from "@commontools/integration";
const { API_URL } = env;

// Create test identity
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};
const identity = await Identity.fromPassphrase("test operator", keyConfig);

console.log("\n=== TEST: Simple object persistence ===");

async function test() {
  // First runtime - save data
  const runtime1 = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
    blobbyServerUrl: API_URL,
  });

  const schema = {
    type: "object",
    properties: {
      message: { type: "string" },
      count: { type: "number" },
    },
    required: ["message", "count"],
  } as const satisfies JSONSchema;

  const cause = "test-object-" + Date.now();
  const cell1 = runtime1.getCell(identity.did(), cause, schema);
  await cell1.sync();

  const tx = runtime1.edit();
  cell1.withTx(tx).set({ message: "Hello World", count: 42 });
  tx.commit();

  await runtime1.storage.synced();
  const cell1Contents = JSON.parse(JSON.stringify(cell1.get()));

  await runtime1.dispose();

  // Second runtime - fetch data
  const runtime2 = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
    blobbyServerUrl: API_URL,
  });

  const cell2 = runtime2.getCell(identity.did(), cause, schema);
  await cell2.sync();
  await runtime2.storage.synced();

  const cell2Contents = JSON.parse(JSON.stringify(cell2.get()));

  await runtime2.dispose();

  return [cell1Contents, cell2Contents];
}

for (let i: number = 1; i <= 20; i++) {
  const [result1, result2] = await test();
  if (!deepEqual(result1, result2)) {
    console.error("Mismatched results for iteration", i, result1, result2);
    Deno.exit(1);
  }
  if (i % 5 == 0) {
    console.log("completed", i, "...");
  }
}

console.log("\nDone");
Deno.exit(0);

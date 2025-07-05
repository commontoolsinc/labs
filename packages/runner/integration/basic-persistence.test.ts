#!/usr/bin/env -S deno run -A

import { deepEqual, Runtime } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type JSONSchema } from "@commontools/runner";

// Create test identity
const identity = await Identity.fromPassphrase("test operator");

console.log("\n=== TEST: Simple object persistence ===");

async function test() {
  // First runtime - save data
  const runtime1 = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", "http://localhost:8000"),
    }),
    blobbyServerUrl: "http://localhost:8000",
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
  await runtime1.storage.syncCell(cell1);

  cell1.set({ message: "Hello World", count: 42 });

  await runtime1.storage.synced();
  console.log("First runtime - data:", cell1.get());
  const cell1Contents = JSON.parse(JSON.stringify(cell1.get()));

  await runtime1.dispose();

  // Second runtime - fetch data
  const runtime2 = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", "http://localhost:8000"),
    }),
    blobbyServerUrl: "http://localhost:8000",
  });

  const cell2 = runtime2.getCell(identity.did(), cause, schema);
  await runtime2.storage.syncCell(cell2);
  await runtime2.storage.synced();

  console.log("Second runtime - data:", cell2.get());
  const cell2Contents = JSON.parse(JSON.stringify(cell2.get()));

  await runtime2.dispose();

  return [cell1Contents, cell2Contents];
}

for (let i: number = 0; i < 100; i++) {
  const [result1, result2] = await test();
  if (!deepEqual(result1, result2)) {
    console.error("Mismatched results:", result1, result2);
    Deno.exit(1);
  }
}

console.log("\nDone");
Deno.exit(0);

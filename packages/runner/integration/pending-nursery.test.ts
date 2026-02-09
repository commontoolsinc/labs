#!/usr/bin/env -S deno run -A

import { assert, assertEquals } from "@std/assert";
import { Runtime } from "@commontools/runner";
import { Identity, IdentityCreateConfig } from "@commontools/identity";
import { Provider, StorageManager } from "@commontools/runner/storage/cache";
import { type JSONSchema } from "@commontools/runner";
import { toURI } from "../src/uri-utils.ts";
import { env } from "@commontools/integration";
const { API_URL } = env;

// Create test identity
const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};
const identity = await Identity.fromPassphrase("test operator", keyConfig);

console.log("\n=== TEST: Simple object persistence ===");

const TIMEOUT_MS = 180000; // 3 minutes timeout

async function test() {
  // First runtime - save data
  const runtime1 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
      memoryVersion: "v1", // v2 remote transport doesn't support graph queries yet
    }),
  });
  const provider1: Provider =
    (runtime1.storageManager.open(identity.did()) as any).provider;

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
  await runtime1.storageManager.syncCell(cell1);
  const tx = runtime1.edit();
  cell1.withTx(tx).set({ message: "Hello World", count: 42 });
  tx.commit();

  await runtime1.storageManager.synced();

  const uri = toURI(cell1.entityId);
  console.log("subscribing to changes for", uri);

  let s1Count = 0;
  provider1.replica.heap.subscribe(
    { id: uri, type: "application/json" },
    (_) => {
      s1Count++;
    },
  );

  // Second runtime - fetch data
  const runtime2 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
      memoryVersion: "v1", // v2 remote transport doesn't support graph queries yet
    }),
  });

  const provider2: Provider =
    (runtime2.storageManager.open(identity.did()) as any).provider;
  let s2Count = 0;
  provider2.replica.heap.subscribe(
    { id: uri, type: "application/json" },
    (_v) => {
      s2Count++;
    },
  );

  const cell2 = runtime2.getCell(identity.did(), cause, schema);
  await runtime2.storageManager.syncCell(cell2);
  await runtime2.storageManager.synced();

  // reset our subscribe callback counters
  s1Count = 0;
  s2Count = 0;

  // Set up a wait for the last value (45)
  const deferred = Promise.withResolvers();
  provider2.replica.heap.subscribe(
    { id: uri, type: "application/json" },
    (v) => {
      if ((v?.is as any).value.count === 45) {
        deferred.resolve(true);
      }
    },
  );

  const timeoutPromise = new Promise<boolean>((resolve) =>
    setTimeout(resolve, 2000, false)
  );

  const tx1a = runtime1.edit();
  cell1.withTx(tx1a).set({ message: "Hello World", count: 43 });
  tx1a.commit();

  const tx1b = runtime1.edit();
  cell1.withTx(tx1b).set({ message: "Hello World", count: 44 });
  tx1b.commit();

  const tx1c = runtime1.edit();
  cell1.withTx(tx1c).set({ message: "Hello World", count: 45 });
  tx1c.commit();

  const synced = await Promise.race([deferred.promise, timeoutPromise]);
  assert(synced, "Timed out before runtime2 received updated values");

  await runtime1.storageManager.synced();
  await runtime2.storageManager.synced();

  // We should have gotten no updates on runner1 and up to three updates on runner2
  assertEquals(s1Count, 0, "Got subscribe response on runtime1 for pending");
  assert(s2Count <= 3, "Got too many messages from runtime2");

  // reset our subscribe callback counters
  s1Count = 0;
  s2Count = 0;

  const tx2a = runtime2.edit();
  cell2.withTx(tx2a).set({ message: "Hello World", count: 46 });
  tx2a.commit();

  await runtime1.storageManager.synced();
  await runtime2.storageManager.synced();

  // We should have gotten one update on runner1 and no updates on runner2
  assertEquals(s1Count, 1);
  assertEquals(s2Count, 0);

  // Have to dispose in reverse order to match frame order
  await runtime2.dispose();
  await runtime1.dispose();
}

async function runTest() {
  for (let i: number = 1; i <= 20; i++) {
    await test();
    console.log("completed", i, "...");
  }

  console.log("\nDone");
}

Deno.test({
  name: "pending nursery test",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([runTest(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

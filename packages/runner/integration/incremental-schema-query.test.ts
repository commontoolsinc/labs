#!/usr/bin/env -S deno run -A

import { assert, assertEquals } from "@std/assert";
import { Runtime } from "@commontools/runner";
import { Identity, type IdentityCreateConfig } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "@commontools/runner";
import { env } from "@commontools/integration";
const { API_URL } = env;

const keyConfig: IdentityCreateConfig = {
  implementation: "noble",
};

const TIMEOUT_MS = 180000; // 3 minutes timeout

/**
 * Test: When a document changes to add a link to another document,
 * the subscriber should receive the linked document's data.
 *
 * Setup phase (runtime1):
 *   - Create document A (no links)
 *   - Create document B (will be linked later)
 *   - Sync and dispose
 *
 * Test phase (runtime2 + runtime3):
 *   - runtime2 subscribes to A
 *   - runtime3 modifies A to add a link to B
 *   - runtime2 should receive B's data in the incremental update
 */
async function testNewLinkDiscovery() {
  console.log("\n=== TEST: New link discovery ===");
  const testId = Date.now().toString();
  const identity = await Identity.fromPassphrase(
    `incremental-test-new-link-${testId}`,
    keyConfig,
  );
  const space = identity.did();

  const addressSchema = {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  } as const satisfies JSONSchema;

  const personSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name"],
  } as const satisfies JSONSchema;

  // === SETUP PHASE ===
  // Create document B (the address) that will later be linked
  const runtime1 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  let tx = runtime1.edit();
  const addressCell = runtime1.getCell(
    space,
    "test-address-cell",
    addressSchema,
    tx,
  );
  addressCell.set({ city: "San Francisco" });
  await tx.commit();

  // Create document A (the person) initially without a link
  tx = runtime1.edit();
  const personCell = runtime1.getCell(
    space,
    "test-person-cell",
    personSchema,
    tx,
  );
  personCell.set({ name: "Alice" }); // No address link yet
  await tx.commit();

  await runtime1.storageManager.synced();
  const addressEntityId = JSON.parse(JSON.stringify(addressCell.entityId));
  await runtime1.dispose();

  // === TEST PHASE ===
  // runtime2 subscribes to the person cell
  const runtime2 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const personCell2 = runtime2.getCell(space, "test-person-cell", personSchema);
  await personCell2.sync();
  await runtime2.storageManager.synced();

  // Verify initial state - person has no address
  const initialValue = personCell2.get();
  assertEquals(initialValue?.name, "Alice");
  assertEquals(initialValue?.address, undefined);

  // In v2, all entities are pre-loaded via wildcard subscription, so we
  // skip the v1-specific heap check that verified the address wasn't
  // in the heap before the link was created.

  // Set up listener for updates
  const updateReceived = Promise.withResolvers<boolean>();
  let receivedAddress = false;

  personCell2.sink((value) => {
    if (value?.address?.city === "San Francisco") {
      receivedAddress = true;
      updateReceived.resolve(true);
    }
  });

  // runtime3 modifies person to add link to address
  const runtime3 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const personCell3 = runtime3.getCell(space, "test-person-cell", personSchema);
  await personCell3.sync();

  tx = runtime3.edit();
  // Update person to link to address using manual link format
  personCell3.withTx(tx).setRaw({
    name: "Alice",
    address: {
      "/": { "link@1": { id: `of:${addressEntityId["/"]}`, path: [] } },
    },
  });
  await tx.commit();
  await runtime3.storageManager.synced();

  // Wait for runtime2 to receive the update
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), 5000)
  );
  const result = await Promise.race([updateReceived.promise, timeout]);

  assert(result, "Should have received update with linked address");
  assert(receivedAddress, "Should have received the address data");

  // In v2, all entities are available via wildcard subscription.
  await runtime2.storageManager.synced();

  await runtime3.dispose();
  await runtime2.dispose();
  console.log("New link discovery test PASSED");
}

/**
 * Test: When a linked document changes, the subscriber should receive the update.
 *
 * Setup phase (runtime1):
 *   - Create document B (address)
 *   - Create document A (person) that links to B
 *   - Sync and dispose
 *
 * Test phase (runtime2 + runtime3):
 *   - runtime2 subscribes to A (which loads B via the link)
 *   - runtime3 modifies B
 *   - runtime2 should receive B's updated data
 */
async function testLinkedDocumentChanges() {
  console.log("\n=== TEST: Linked document changes ===");
  const testId = Date.now().toString();
  const identity = await Identity.fromPassphrase(
    `incremental-test-linked-change-${testId}`,
    keyConfig,
  );
  const space = identity.did();

  const addressSchema = {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  } as const satisfies JSONSchema;

  const personSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name", "address"],
  } as const satisfies JSONSchema;

  // === SETUP PHASE ===
  const runtime1 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  // Create address cell first
  let tx = runtime1.edit();
  const addressCell = runtime1.getCell(
    space,
    "linked-address-cell",
    addressSchema,
    tx,
  );
  addressCell.set({ city: "New York" });
  await tx.commit();
  await addressCell.sync();
  await runtime1.storageManager.synced();

  // Get the address entity ID for creating the link
  const addressEntityId = JSON.parse(JSON.stringify(addressCell.entityId));

  // Create person cell that links to address
  tx = runtime1.edit();
  const personCell = runtime1.getCell(
    space,
    "linked-person-cell",
    personSchema,
    tx,
  );
  // Create a manual link to the address cell
  personCell.setRaw({
    name: "Bob",
    address: {
      "/": { "link@1": { id: `of:${addressEntityId["/"]}`, path: [] } },
    },
  });
  await tx.commit();

  await runtime1.storageManager.synced();
  await runtime1.dispose();

  // === TEST PHASE ===
  const runtime2 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const personCell2 = runtime2.getCell(
    space,
    "linked-person-cell",
    personSchema,
  );
  await personCell2.sync();
  await runtime2.storageManager.synced();

  // Verify initial state
  const initialValue = personCell2.get();
  assertEquals(initialValue?.name, "Bob");
  assertEquals(initialValue?.address?.city, "New York");

  // Set up listener for updates
  const updateReceived = Promise.withResolvers<boolean>();
  let receivedNewCity = false;

  personCell2.sink((value) => {
    if (value?.address?.city === "Los Angeles") {
      receivedNewCity = true;
      updateReceived.resolve(true);
    }
  });

  // runtime3 modifies the address
  const runtime3 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const addressCell3 = runtime3.getCell(
    space,
    "linked-address-cell",
    addressSchema,
  );
  await addressCell3.sync();

  tx = runtime3.edit();
  addressCell3.withTx(tx).set({ city: "Los Angeles" });
  await tx.commit();
  await runtime3.storageManager.synced();

  // Wait for runtime2 to receive the update
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), 5000)
  );
  const result = await Promise.race([updateReceived.promise, timeout]);

  assert(result, "Should have received update for linked document change");
  assert(receivedNewCity, "Should have received the updated city");

  await runtime3.dispose();
  await runtime2.dispose();
  console.log("Linked document changes test PASSED");
}

/**
 * Test: Deep link chain - A links to B, B links to C.
 * When C changes, subscriber to A should receive the update.
 *
 * Setup phase:
 *   - Create C (city)
 *   - Create B (address) linking to C
 *   - Create A (person) linking to B
 *
 * Test phase:
 *   - Subscribe to A
 *   - Modify C
 *   - Should receive C's update
 */
async function testDeepLinkChain() {
  console.log("\n=== TEST: Deep link chain (A -> B -> C) ===");
  const testId = Date.now().toString();
  const identity = await Identity.fromPassphrase(
    `incremental-test-deep-chain-${testId}`,
    keyConfig,
  );
  const space = identity.did();

  const citySchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      population: { type: "number" },
    },
    required: ["name"],
  } as const satisfies JSONSchema;

  const addressSchema = {
    type: "object",
    properties: {
      street: { type: "string" },
      city: citySchema,
    },
    required: ["street", "city"],
  } as const satisfies JSONSchema;

  const personSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      address: addressSchema,
    },
    required: ["name", "address"],
  } as const satisfies JSONSchema;

  // === SETUP PHASE ===
  const runtime1 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  // Create city cell (C)
  let tx = runtime1.edit();
  const cityCell = runtime1.getCell(space, "deep-city-cell", citySchema, tx);
  cityCell.set({ name: "Seattle", population: 750000 });
  await tx.commit();
  await cityCell.sync();
  await runtime1.storageManager.synced();
  const cityEntityId = JSON.parse(JSON.stringify(cityCell.entityId));

  // Create address cell (B) linking to city using manual link format
  tx = runtime1.edit();
  const addressCell = runtime1.getCell(
    space,
    "deep-address-cell",
    addressSchema,
    tx,
  );
  addressCell.setRaw({
    street: "123 Main St",
    city: {
      "/": { "link@1": { id: `of:${cityEntityId["/"]}`, path: [] } },
    },
  });
  await tx.commit();
  await addressCell.sync();
  await runtime1.storageManager.synced();
  const addressEntityId = JSON.parse(JSON.stringify(addressCell.entityId));

  // Create person cell (A) linking to address using manual link format
  tx = runtime1.edit();
  const personCell = runtime1.getCell(
    space,
    "deep-person-cell",
    personSchema,
    tx,
  );
  personCell.setRaw({
    name: "Charlie",
    address: {
      "/": { "link@1": { id: `of:${addressEntityId["/"]}`, path: [] } },
    },
  });
  await tx.commit();

  await runtime1.storageManager.synced();
  await runtime1.dispose();

  // === TEST PHASE ===
  const runtime2 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const personCell2 = runtime2.getCell(space, "deep-person-cell", personSchema);
  await personCell2.sync();
  await runtime2.storageManager.synced();

  // Verify initial state - full chain is loaded
  const initialValue = personCell2.get();
  assertEquals(initialValue?.name, "Charlie");
  assertEquals(initialValue?.address?.street, "123 Main St");
  assertEquals(initialValue?.address?.city?.name, "Seattle");
  assertEquals(initialValue?.address?.city?.population, 750000);

  // Set up listener for updates
  const updateReceived = Promise.withResolvers<boolean>();
  let receivedNewPopulation = false;

  personCell2.sink((value) => {
    if (value?.address?.city?.population === 800000) {
      receivedNewPopulation = true;
      updateReceived.resolve(true);
    }
  });

  // runtime3 modifies the city (C)
  const runtime3 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const cityCell3 = runtime3.getCell(space, "deep-city-cell", citySchema);
  await cityCell3.sync();

  tx = runtime3.edit();
  cityCell3.withTx(tx).set({ name: "Seattle", population: 800000 });
  await tx.commit();
  await runtime3.storageManager.synced();

  // Wait for runtime2 to receive the update
  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), 5000)
  );
  const result = await Promise.race([updateReceived.promise, timeout]);

  assert(result, "Should have received update for deep link chain");
  assert(receivedNewPopulation, "Should have received the updated population");

  await runtime3.dispose();
  await runtime2.dispose();
  console.log("Deep link chain test PASSED");
}

/**
 * Test: Directly queried document changes should trigger updates.
 */
async function testDirectDocumentChanges() {
  console.log("\n=== TEST: Direct document changes ===");
  const testId = Date.now().toString();
  const identity = await Identity.fromPassphrase(
    `incremental-test-direct-${testId}`,
    keyConfig,
  );
  const space = identity.did();

  const counterSchema = {
    type: "object",
    properties: {
      count: { type: "number" },
    },
    required: ["count"],
  } as const satisfies JSONSchema;

  // === SETUP PHASE ===
  const runtime1 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  let tx = runtime1.edit();
  const counterCell = runtime1.getCell(
    space,
    "direct-counter-cell",
    counterSchema,
    tx,
  );
  counterCell.set({ count: 0 });
  await tx.commit();
  await runtime1.storageManager.synced();
  await runtime1.dispose();

  // === TEST PHASE ===
  const runtime2 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const counterCell2 = runtime2.getCell(
    space,
    "direct-counter-cell",
    counterSchema,
  );
  await counterCell2.sync();
  await runtime2.storageManager.synced();

  assertEquals(counterCell2.get()?.count, 0);

  // Set up listener
  const updateReceived = Promise.withResolvers<boolean>();
  counterCell2.sink((value) => {
    if (value?.count === 42) {
      updateReceived.resolve(true);
    }
  });

  // runtime3 modifies the counter
  const runtime3 = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  const counterCell3 = runtime3.getCell(
    space,
    "direct-counter-cell",
    counterSchema,
  );
  await counterCell3.sync();

  tx = runtime3.edit();
  counterCell3.withTx(tx).set({ count: 42 });
  await tx.commit();
  await runtime3.storageManager.synced();

  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), 5000)
  );
  const result = await Promise.race([updateReceived.promise, timeout]);

  assert(result, "Should have received update for direct document change");

  await runtime3.dispose();
  await runtime2.dispose();
  console.log("Direct document changes test PASSED");
}

// Run all tests
async function runTests() {
  await testDirectDocumentChanges();
  await testLinkedDocumentChanges();
  await testNewLinkDiscovery();
  await testDeepLinkChain();
  console.log("\n=== All incremental schema query tests PASSED ===");
}

Deno.test({
  name: "incremental schema query tests",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([runTests(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

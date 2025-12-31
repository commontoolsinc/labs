import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("nursery bench operator");
const space = signer.did();

/**
 * Benchmark: Reading from nursery (pending commits) vs heap (synced data)
 *
 * This benchmark investigates the performance difference between:
 * 1. Reading data in the nursery (after commit, before sync)
 * 2. Reading data from the heap (after sync completes)
 *
 * Hypothesis: Heap reads have overhead from object destructuring that
 * happens on every read, while nursery reads return data directly.
 */

// Benchmark: Simple value reads from nursery
Deno.bench("Cell get - simple value from nursery (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<number>(space, "bench-nursery-simple", undefined, tx);

  // Set a value
  cell.set(42);

  // Commit to move to nursery
  await tx.commit();

  // Read many times while still in nursery (before sync)
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Simple value reads from heap
Deno.bench("Cell get - simple value from heap (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<number>(space, "bench-heap-simple", undefined, tx);

  // Set a value
  cell.set(42);

  // Commit and wait for sync to move to heap
  await tx.commit();
  await runtime.storageManager.synced();

  // Read many times from heap
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Complex object reads from nursery
Deno.bench("Cell get - complex object from nursery (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const schema = {
    type: "object",
    properties: {
      id: { type: "number" },
      name: { type: "string" },
      email: { type: "string" },
      age: { type: "number" },
      address: {
        type: "object",
        properties: {
          street: { type: "string" },
          city: { type: "string" },
          state: { type: "string" },
          zip: { type: "string" },
        },
      },
      tags: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
    },
  } as const satisfies JSONSchema;

  const tx = runtime.edit();
  const cell = runtime.getCell(space, "bench-nursery-complex", schema, tx);

  // Set a complex value
  cell.set({
    id: 1,
    name: "John Doe",
    email: "john@example.com",
    age: 30,
    address: {
      street: "123 Main St",
      city: "Anytown",
      state: "CA",
      zip: "12345",
    },
    tags: ["developer", "typescript", "performance"],
    metadata: { created: "2025-01-01", updated: "2025-01-22" },
  });

  // Commit to move to nursery
  await tx.commit();

  // Read many times while still in nursery
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Complex object reads from heap
Deno.bench("Cell get - complex object from heap (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const schema = {
    type: "object",
    properties: {
      id: { type: "number" },
      name: { type: "string" },
      email: { type: "string" },
      age: { type: "number" },
      address: {
        type: "object",
        properties: {
          street: { type: "string" },
          city: { type: "string" },
          state: { type: "string" },
          zip: { type: "string" },
        },
      },
      tags: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
    },
  } as const satisfies JSONSchema;

  const tx = runtime.edit();
  const cell = runtime.getCell(space, "bench-heap-complex", schema, tx);

  // Set a complex value
  cell.set({
    id: 1,
    name: "John Doe",
    email: "john@example.com",
    age: 30,
    address: {
      street: "123 Main St",
      city: "Anytown",
      state: "CA",
      zip: "12345",
    },
    tags: ["developer", "typescript", "performance"],
    metadata: { created: "2025-01-01", updated: "2025-01-22" },
  });

  // Commit and wait for sync to move to heap
  await tx.commit();
  await runtime.storageManager.synced();

  // Read many times from heap
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Object with many properties from nursery
Deno.bench("Cell get - wide object (50 props) from nursery (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<Record<string, number>>(
    space,
    "bench-nursery-wide",
    undefined,
    tx,
  );

  // Create object with 50 properties
  const wideObject: Record<string, number> = {};
  for (let i = 0; i < 50; i++) {
    wideObject[`prop${i}`] = i;
  }

  cell.set(wideObject);

  // Commit to move to nursery
  await tx.commit();

  // Read many times while still in nursery
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Object with many properties from heap
Deno.bench("Cell get - wide object (50 props) from heap (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<Record<string, number>>(
    space,
    "bench-heap-wide",
    undefined,
    tx,
  );

  // Create object with 50 properties
  const wideObject: Record<string, number> = {};
  for (let i = 0; i < 50; i++) {
    wideObject[`prop${i}`] = i;
  }

  cell.set(wideObject);

  // Commit and wait for sync to move to heap
  await tx.commit();
  await runtime.storageManager.synced();

  // Read many times from heap (should show destructuring overhead)
  for (let i = 0; i < 1000; i++) {
    cell.get();
  }

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Nested cell access from nursery
Deno.bench("Cell get - nested access from nursery (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<{
    user: { profile: { name: string; age: number } };
  }>(space, "bench-nursery-nested", undefined, tx);

  cell.set({
    user: {
      profile: {
        name: "Alice",
        age: 25,
      },
    },
  });

  // Commit to move to nursery
  await tx.commit();

  // Read nested value many times
  for (let i = 0; i < 1000; i++) {
    cell.key("user").key("profile").key("name").get();
  }

  await runtime.dispose();
  await storageManager.close();
});

// Benchmark: Nested cell access from heap
Deno.bench("Cell get - nested access from heap (1000x)", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  const tx = runtime.edit();
  const cell = runtime.getCell<{
    user: { profile: { name: string; age: number } };
  }>(space, "bench-heap-nested", undefined, tx);

  cell.set({
    user: {
      profile: {
        name: "Alice",
        age: 25,
      },
    },
  });

  // Commit and wait for sync to move to heap
  await tx.commit();
  await runtime.storageManager.synced();

  // Read nested value many times (each level does a heap read)
  for (let i = 0; i < 1000; i++) {
    cell.key("user").key("profile").key("name").get();
  }

  await runtime.dispose();
  await storageManager.close();
});

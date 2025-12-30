/**
 * Storage layer benchmarks - measuring raw transaction read/write performance
 */
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("bench storage");
const space = signer.did();

// Setup helper
function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  runtime.scheduler.disablePullMode();
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

// Cleanup helper
async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx: IExtendedStorageTransaction,
) {
  await tx.commit();
  await runtime.dispose();
  await storageManager.close();
}

// ============================================================================
// Write operations
// ============================================================================

Deno.bench(
  "Storage - tx.write raw (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:raw-w-${i}`,
          type: "application/json",
          path: ["value"],
        },
        i,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.writeOrThrow (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.writeOrThrow(
        {
          space,
          id: `test:throw-w-${i}`,
          type: "application/json",
          path: ["value"],
        },
        i,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.writeValueOrThrow (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.writeValueOrThrow(
        {
          space,
          id: `test:value-w-${i}`,
          type: "application/json",
          path: [],
        },
        i,
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.write to root path (100x)",
  { group: "write-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:root-write-${i}`,
          type: "application/json",
          path: [],
        },
        { value: i },
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

// ============================================================================
// Read operations
// ============================================================================

Deno.bench(
  "Storage - tx.read after tx.write (100x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write with tx.write to root
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:read-raw-${i}`,
          type: "application/json",
          path: [],
        },
        { value: i },
      );
    }

    // Read with tx.read
    for (let i = 0; i < 100; i++) {
      tx.read({
        space,
        id: `test:read-raw-${i}`,
        type: "application/json",
        path: ["value"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.readOrThrow after tx.write (100x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write with tx.write to root
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:read-throw-${i}`,
          type: "application/json",
          path: [],
        },
        { value: i },
      );
    }

    // Read with tx.readOrThrow
    for (let i = 0; i < 100; i++) {
      tx.readOrThrow({
        space,
        id: `test:read-throw-${i}`,
        type: "application/json",
        path: ["value"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - readValueOrThrow after writeValueOrThrow (100x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write with writeValueOrThrow
    for (let i = 0; i < 100; i++) {
      tx.writeValueOrThrow(
        {
          space,
          id: `test:read-value-${i}`,
          type: "application/json",
          path: [],
        },
        i,
      );
    }

    // Read with readValueOrThrow
    for (let i = 0; i < 100; i++) {
      tx.readValueOrThrow({
        space,
        id: `test:read-value-${i}`,
        type: "application/json",
        path: [],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - tx.read only, pre-written (1000x)",
  { group: "read-operations" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Pre-write with tx.write to root
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:prewrite-${i}`,
          type: "application/json",
          path: [],
        },
        { value: i },
      );
    }

    // Many reads on same entities
    for (let j = 0; j < 1000; j++) {
      tx.read({
        space,
        id: `test:prewrite-${j % 100}`,
        type: "application/json",
        path: ["value"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

// ============================================================================
// Entity creation overhead
// ============================================================================

Deno.bench(
  "Storage - new entity overhead (100x)",
  { group: "entity-creation" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Each write to a new entity root
    for (let i = 0; i < 100; i++) {
      const result = tx.write(
        {
          space,
          id: `test:create-${i}`,
          type: "application/json",
          path: [],
        },
        i,
      );
      if (result.error) throw new Error("Write failed");
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - same entity writes (100x)",
  { group: "entity-creation" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // First write creates entity
    tx.write(
      {
        space,
        id: "test:same-entity-repeat",
        type: "application/json",
        path: [],
      },
      { value: 0 },
    );

    // Subsequent writes just update
    for (let i = 1; i < 100; i++) {
      tx.write(
        {
          space,
          id: "test:same-entity-repeat",
          type: "application/json",
          path: [],
        },
        { value: i },
      );
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - nested path on existing (100x)",
  { group: "entity-creation" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Create 100 entities first
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:existing-${i}`,
          type: "application/json",
          path: [],
        },
        { value: 0 },
      );
    }

    // Now write to nested path (should be fast, entity exists)
    for (let i = 0; i < 100; i++) {
      const result = tx.write(
        {
          space,
          id: `test:existing-${i}`,
          type: "application/json",
          path: ["value"],
        },
        i,
      );
      if (result.error) throw new Error("Nested write failed");
    }

    await cleanup(runtime, storageManager, tx);
  },
);

// ============================================================================
// Path depth comparison
// ============================================================================

Deno.bench(
  "Storage - read shallow path (100x)",
  { group: "path-depth" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write deeply nested structure
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:path-${i}`,
          type: "application/json",
          path: [],
        },
        { a: { b: { c: { d: { e: { f: i } } } } } },
      );
    }

    // Read shallow path
    for (let i = 0; i < 100; i++) {
      tx.read({
        space,
        id: `test:path-${i}`,
        type: "application/json",
        path: ["a"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

Deno.bench(
  "Storage - read deep path (100x)",
  { group: "path-depth" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write deeply nested structure
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:deep-path-${i}`,
          type: "application/json",
          path: [],
        },
        { a: { b: { c: { d: { e: { f: i } } } } } },
      );
    }

    // Read deep path (6 levels)
    for (let i = 0; i < 100; i++) {
      tx.read({
        space,
        id: `test:deep-path-${i}`,
        type: "application/json",
        path: ["a", "b", "c", "d", "e", "f"],
      });
    }

    await cleanup(runtime, storageManager, tx);
  },
);

// ============================================================================
// Commit overhead
// ============================================================================

Deno.bench(
  "Storage - empty commit",
  { group: "commit" },
  async () => {
    const { runtime, storageManager, tx } = setup();
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Storage - commit after 100 writes",
  { group: "commit" },
  async () => {
    const { runtime, storageManager, tx } = setup();

    // Write 100 entities
    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:commit-${i}`,
          type: "application/json",
          path: [],
        },
        { value: i },
      );
    }

    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  },
);

// ============================================================================
// Overhead sources (microbenchmarks)
// ============================================================================

Deno.bench(
  "Overhead - object creation (1000x)",
  { group: "overhead" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _addr = {
        space,
        id: `test:obj-${i}`,
        type: "application/json",
        path: ["value", "nested"],
      };
    }
  },
);

Deno.bench(
  "Overhead - object spread (1000x)",
  { group: "overhead" },
  () => {
    const base = {
      space,
      id: "test:base",
      type: "application/json",
      path: [] as string[],
    };
    for (let i = 0; i < 1000; i++) {
      const _addr = { ...base, path: ["value", ...base.path] };
    }
  },
);

Deno.bench(
  "Overhead - Map operations (1000x)",
  { group: "overhead" },
  () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const key = `test:entity-${i % 100}/application/json`;
      map.set(key, i);
      map.get(key);
    }
  },
);

Deno.bench(
  "Overhead - string template keys (1000x)",
  { group: "overhead" },
  () => {
    for (let i = 0; i < 1000; i++) {
      const _key = `test:entity-${i % 100}/application/json`;
    }
  },
);

Deno.bench(
  "Overhead - array push (1000x)",
  { group: "overhead" },
  () => {
    const activity: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      activity.push({
        read: {
          space,
          id: `test:activity-${i}`,
          type: "application/json",
          path: ["value"],
          meta: {},
        },
      });
    }
  },
);

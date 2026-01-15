/**
 * Server simulation benchmarks - measuring attestation.claim() slow path
 *
 * These benchmarks stub Replica.prototype.get to simulate the effect of a
 * server round-trip: data comes back with the same logical value but different
 * object references. This forces the "slow path" in attestation.claim() where
 * JSON.stringify comparison is needed.
 *
 * In normal emulated mode, reference equality always passes because Chronicle
 * preserves original references when values are deepEqual. A real server
 * would re-serialize data, breaking reference equality.
 */
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { Replica } from "../src/storage/cache.ts";

const signer = await Identity.fromPassphrase("bench server sim");
const space = signer.did();

// ============================================================================
// Setup helper
// ============================================================================

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

// ============================================================================
// Test fixtures
// ============================================================================

const medianComplexityA = {
  items: [
    { id: "item-1", title: "Buy groceries", done: false, priority: 1 },
    { id: "item-2", title: "Call mom", done: true, priority: 2 },
    { id: "item-3", title: "Finish report", done: false, priority: 1 },
    { id: "item-4", title: "Schedule dentist", done: false, priority: 3 },
    { id: "item-5", title: "Review PR", done: true, priority: 1 },
  ],
  metadata: {
    createdAt: "2024-01-15T10:30:00Z",
    updatedAt: "2024-01-15T14:22:00Z",
    version: 3,
  },
};

const hugeString = "x".repeat(100_000);

const largeStringA = {
  items: [
    { id: "item-1", title: "Buy groceries", done: false, priority: 1 },
    { id: "item-2", title: "Call mom", done: true, priority: 2 },
  ],
  content: hugeString,
  metadata: {
    createdAt: "2024-01-15T10:30:00Z",
    version: 1,
  },
};

// ============================================================================
// Replica.prototype.get stub for simulating server round-trips
// ============================================================================

const originalReplicaGet = Replica.prototype.get;

function stubReplicaGetWithReserialization() {
  Replica.prototype.get = function (entry) {
    // Check nursery first (unchanged - these have original tx references)
    const nurseryState = this.nursery.get(entry);
    if (nurseryState) return nurseryState;

    // For heap data, simulate server re-serialization by deep-cloning `is`
    const heapState = this.heap.get(entry);
    if (heapState) {
      const { since: _since, ...state } = heapState;
      // Break reference equality on the value (simulates server serialization)
      if (state.is !== undefined) {
        return { ...state, is: JSON.parse(JSON.stringify(state.is)) };
      }
      return state;
    }
    return undefined;
  };
}

function restoreReplicaGet() {
  Replica.prototype.get = originalReplicaGet;
}

// ============================================================================
// Server simulation benchmarks - large strings
// ============================================================================

Deno.bench(
  "Server sim OFF - read validation, large string (50x)",
  { group: "server-simulation" },
  async (b) => {
    restoreReplicaGet(); // Ensure clean state
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 50; i++) {
      tx.write(
        {
          space,
          id: `test:serversim-off-${i}`,
          type: "application/json",
          path: [],
        },
        largeStringA,
      );
    }
    await tx.commit();

    const tx2 = runtime.edit();
    for (let i = 0; i < 50; i++) {
      tx2.read({
        space,
        id: `test:serversim-off-${i}`,
        type: "application/json",
        path: [],
      });
    }

    b.start();
    await tx2.commit();
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Server sim ON - read validation, large string (50x)",
  { group: "server-simulation" },
  async (b) => {
    stubReplicaGetWithReserialization();
    try {
      const { runtime, storageManager, tx } = setup();

      for (let i = 0; i < 50; i++) {
        tx.write(
          {
            space,
            id: `test:serversim-on-${i}`,
            type: "application/json",
            path: [],
          },
          largeStringA,
        );
      }
      await tx.commit();

      const tx2 = runtime.edit();
      for (let i = 0; i < 50; i++) {
        tx2.read({
          space,
          id: `test:serversim-on-${i}`,
          type: "application/json",
          path: [],
        });
      }

      b.start();
      await tx2.commit();
      b.end();

      await runtime.dispose();
      await storageManager.close();
    } finally {
      restoreReplicaGet();
    }
  },
);

// ============================================================================
// Server simulation benchmarks - median complexity
// ============================================================================

Deno.bench(
  "Server sim OFF - read validation, median complexity (100x)",
  { group: "server-simulation-median" },
  async (b) => {
    restoreReplicaGet();
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      tx.write(
        {
          space,
          id: `test:serversim-med-off-${i}`,
          type: "application/json",
          path: [],
        },
        medianComplexityA,
      );
    }
    await tx.commit();

    const tx2 = runtime.edit();
    for (let i = 0; i < 100; i++) {
      tx2.read({
        space,
        id: `test:serversim-med-off-${i}`,
        type: "application/json",
        path: [],
      });
    }

    b.start();
    await tx2.commit();
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Server sim ON - read validation, median complexity (100x)",
  { group: "server-simulation-median" },
  async (b) => {
    stubReplicaGetWithReserialization();
    try {
      const { runtime, storageManager, tx } = setup();

      for (let i = 0; i < 100; i++) {
        tx.write(
          {
            space,
            id: `test:serversim-med-on-${i}`,
            type: "application/json",
            path: [],
          },
          medianComplexityA,
        );
      }
      await tx.commit();

      const tx2 = runtime.edit();
      for (let i = 0; i < 100; i++) {
        tx2.read({
          space,
          id: `test:serversim-med-on-${i}`,
          type: "application/json",
          path: [],
        });
      }

      b.start();
      await tx2.commit();
      b.end();

      await runtime.dispose();
      await storageManager.close();
    } finally {
      restoreReplicaGet();
    }
  },
);

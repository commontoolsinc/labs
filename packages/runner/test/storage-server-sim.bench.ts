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
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { Nursery, Replica } from "../src/storage/cache.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";
import {
  largeStringA,
  manySmallObjectsA,
  medianComplexityA,
} from "./bench-fixtures.ts";
import type { FabricValue } from "@commonfabric/memory/interface";

const signer = await Identity.fromPassphrase("bench server sim");
const space = signer.did();

// ============================================================================
// Setup helper
// ============================================================================

function setup() {
  const storageManager = StorageManager.emulate({
    as: signer,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  runtime.scheduler.disablePullMode();
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

const writeDocument = (
  tx: IExtendedStorageTransaction,
  id: string,
  value: FabricValue,
) => {
  tx.writeValueOrThrow({
    space,
    id: id as `test:${string}`,
    type: "application/json",
    path: [],
  }, value);
};

const readDocument = (
  tx: IExtendedStorageTransaction,
  id: string,
) => {
  tx.readValueOrThrow({
    space,
    id: id as `test:${string}`,
    type: "application/json",
    path: [],
  });
};

// ============================================================================
// Pre-cloned fixture versions for server simulation
//
// We pre-create cloned versions of each fixture to simulate what happens when
// a server round-trip re-serializes data (breaking reference equality).
// This avoids JSON.stringify/parse in the hot path during benchmarking.
// ============================================================================

// Pre-cloned versions (same values, different object references)
const medianComplexityA_cloned = JSON.parse(JSON.stringify(medianComplexityA));
const largeStringA_cloned = JSON.parse(JSON.stringify(largeStringA));
const manySmallObjectsA_cloned = JSON.parse(JSON.stringify(manySmallObjectsA));

// Map from original fixture to its clone for O(1) lookup
const fixtureClones = new Map<unknown, unknown>([
  [medianComplexityA, medianComplexityA_cloned],
  [largeStringA, largeStringA_cloned],
  [manySmallObjectsA, manySmallObjectsA_cloned],
]);

// ============================================================================
// Replica.prototype.get stub for simulating server round-trips
// ============================================================================

const originalReplicaGet = Replica.prototype.get;

function stubReplicaGetWithReserialization() {
  Replica.prototype.get = function (entry) {
    // Check nursery first (unchanged - these have original tx references)
    const nurseryState = this.nursery.get(entry);
    if (nurseryState) return nurseryState;

    // For heap data, simulate server re-serialization by substituting
    // a pre-cloned version of the value (breaking reference equality)
    const heapState = this.heap.get(entry);
    if (heapState) {
      const { since: _since, ...state } = heapState;
      if (state.is !== undefined) {
        // Use pre-cloned fixture if available, otherwise clone on demand
        const cloned = fixtureClones.get(state.is) ??
          JSON.parse(JSON.stringify(state.is));
        return { ...state, is: cloned };
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
      writeDocument(tx, `test:serversim-off-${i}`, largeStringA);
    }
    await tx.commit();

    const tx2 = runtime.edit();
    for (let i = 0; i < 50; i++) {
      readDocument(tx2, `test:serversim-off-${i}`);
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
        writeDocument(tx, `test:serversim-on-${i}`, largeStringA);
      }
      await tx.commit();

      const tx2 = runtime.edit();
      for (let i = 0; i < 50; i++) {
        readDocument(tx2, `test:serversim-on-${i}`);
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
      writeDocument(tx, `test:serversim-med-off-${i}`, medianComplexityA);
    }
    await tx.commit();

    const tx2 = runtime.edit();
    for (let i = 0; i < 100; i++) {
      readDocument(tx2, `test:serversim-med-off-${i}`);
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
        writeDocument(tx, `test:serversim-med-on-${i}`, medianComplexityA);
      }
      await tx.commit();

      const tx2 = runtime.edit();
      for (let i = 0; i < 100; i++) {
        readDocument(tx2, `test:serversim-med-on-${i}`);
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
// Server simulation benchmarks - many small objects
// ============================================================================

Deno.bench(
  "Server sim OFF - read validation, many small objects (25x)",
  { group: "server-simulation-many-objects" },
  async (b) => {
    restoreReplicaGet();
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 25; i++) {
      writeDocument(tx, `test:serversim-many-off-${i}`, manySmallObjectsA);
    }
    await tx.commit();

    const tx2 = runtime.edit();
    for (let i = 0; i < 25; i++) {
      readDocument(tx2, `test:serversim-many-off-${i}`);
    }

    b.start();
    await tx2.commit();
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Server sim ON - read validation, many small objects (25x)",
  { group: "server-simulation-many-objects" },
  async (b) => {
    stubReplicaGetWithReserialization();
    try {
      const { runtime, storageManager, tx } = setup();

      for (let i = 0; i < 25; i++) {
        writeDocument(tx, `test:serversim-many-on-${i}`, manySmallObjectsA);
      }
      await tx.commit();

      const tx2 = runtime.edit();
      for (let i = 0; i < 25; i++) {
        readDocument(tx2, `test:serversim-many-on-${i}`);
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
// Nursery.evict stub for forcing slow path comparison
//
// Nursery.evict is called when a transaction commit succeeds, comparing
// nursery state (before) with server-confirmed state (after). The slow path
// (JSON.stringify comparison) only triggers when before.is !== after.is,
// which rarely happens in practice since references are usually preserved.
//
// This stub clones the `before` state to force the slow path.
// ============================================================================

const originalNurseryEvict = Nursery.evict;

function stubNurseryEvictWithCloning() {
  // deno-lint-ignore no-explicit-any
  Nursery.evict = function (before: any, after: any) {
    // Clone before to break reference equality, forcing slow path
    const clonedBefore = before?.is !== undefined
      ? {
        ...before,
        is: fixtureClones.get(before.is) ??
          JSON.parse(JSON.stringify(before.is)),
      }
      : before;
    // Delegate to original implementation with cloned argument
    return originalNurseryEvict(clonedBefore, after);
  };
}

function restoreNurseryEvict() {
  Nursery.evict = originalNurseryEvict;
}

// ============================================================================
// Nursery.evict benchmarks - large strings
// ============================================================================

Deno.bench(
  "Nursery.evict OFF - commit with large string (50x)",
  { group: "nursery-evict" },
  async (b) => {
    restoreNurseryEvict(); // Ensure clean state
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 50; i++) {
      writeDocument(tx, `test:nursery-evict-off-${i}`, largeStringA);
    }

    b.start();
    await tx.commit();
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Nursery.evict ON - commit with large string (50x)",
  { group: "nursery-evict" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();
    stubNurseryEvictWithCloning();
    try {
      for (let i = 0; i < 50; i++) {
        writeDocument(tx, `test:nursery-evict-on-${i}`, largeStringA);
      }

      b.start();
      await tx.commit();
      b.end();

      await runtime.dispose();
      await storageManager.close();
    } finally {
      restoreNurseryEvict();
    }
  },
);

// ============================================================================
// Nursery.evict benchmarks - median complexity
// ============================================================================

Deno.bench(
  "Nursery.evict OFF - commit with median complexity (100x)",
  { group: "nursery-evict-median" },
  async (b) => {
    restoreNurseryEvict();
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 100; i++) {
      writeDocument(tx, `test:nursery-evict-med-off-${i}`, medianComplexityA);
    }

    b.start();
    await tx.commit();
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Nursery.evict ON - commit with median complexity (100x)",
  { group: "nursery-evict-median" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();
    stubNurseryEvictWithCloning();
    try {
      for (let i = 0; i < 100; i++) {
        writeDocument(tx, `test:nursery-evict-med-on-${i}`, medianComplexityA);
      }

      b.start();
      await tx.commit();
      b.end();

      await runtime.dispose();
      await storageManager.close();
    } finally {
      restoreNurseryEvict();
    }
  },
);

// ============================================================================
// Nursery.evict benchmarks - many small objects
// ============================================================================

Deno.bench(
  "Nursery.evict OFF - commit with many small objects (25x)",
  { group: "nursery-evict-many-objects" },
  async (b) => {
    restoreNurseryEvict();
    const { runtime, storageManager, tx } = setup();

    for (let i = 0; i < 25; i++) {
      writeDocument(tx, `test:nursery-evict-many-off-${i}`, manySmallObjectsA);
    }

    b.start();
    await tx.commit();
    b.end();

    await runtime.dispose();
    await storageManager.close();
  },
);

Deno.bench(
  "Nursery.evict ON - commit with many small objects (25x)",
  { group: "nursery-evict-many-objects" },
  async (b) => {
    const { runtime, storageManager, tx } = setup();
    stubNurseryEvictWithCloning();
    try {
      for (let i = 0; i < 25; i++) {
        writeDocument(tx, `test:nursery-evict-many-on-${i}`, manySmallObjectsA);
      }

      b.start();
      await tx.commit();
      b.end();

      await runtime.dispose();
      await storageManager.close();
    } finally {
      restoreNurseryEvict();
    }
  },
);

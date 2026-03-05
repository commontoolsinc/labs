/**
 * Hashing Performance Benchmarks: Legacy (merkle-reference) vs. Canonical
 *
 * Compares the two hashing paths used by `refer()`:
 * - Legacy: merkle-reference tree builder with primitive LRU + WeakMap caching
 * - Canonical: `canonicalHash()` single-pass incremental SHA-256
 *
 * Uses `setCanonicalHashConfig()` / `resetCanonicalHashConfig()` to switch
 * between paths, same pattern as the unit tests.
 *
 * Run with: deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check test/hashing-bench.ts
 */

import {
  type DefinedReferent,
  refer,
  resetCanonicalHashConfig,
  setCanonicalHashConfig,
} from "../reference.ts";
import { canonicalHash } from "../canonical-hash.ts";

// ---------------------------------------------------------------------------
// Helpers: configure refer() for legacy vs. canonical
// ---------------------------------------------------------------------------

function legacyRefer<T extends DefinedReferent>(source: T): unknown {
  setCanonicalHashConfig(false);
  try {
    return refer(source);
  } finally {
    resetCanonicalHashConfig();
  }
}

function canonicalRefer<T extends DefinedReferent>(source: T): unknown {
  setCanonicalHashConfig(true);
  try {
    return refer(source);
  } finally {
    resetCanonicalHashConfig();
  }
}

// ---------------------------------------------------------------------------
// Pre-generated test data
// ---------------------------------------------------------------------------

const smallObject = {
  name: "Alice",
  age: 30,
  active: true,
  score: 95.5,
  tag: null,
};

function makeMediumObject() {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < 15; i++) {
    obj[`key_${i}`] = {
      value: `value_${i}`,
      count: i * 10,
      nested: { a: i, b: `nested_${i}`, flag: i % 2 === 0 },
    };
  }
  return obj;
}
const mediumObject = makeMediumObject();

function makeLargeNestedTree(
  depth: number,
  breadth: number,
): Record<string, unknown> {
  if (depth === 0) {
    return { leaf: true, value: 42.5, label: "leaf-node" };
  }
  const children: Record<string, unknown> = {};
  for (let i = 0; i < breadth; i++) {
    children[`child_${i}`] = makeLargeNestedTree(depth - 1, breadth);
  }
  return { depth, children };
}
const largeNestedTree = makeLargeNestedTree(6, 3); // ~364 nodes

const smallArray = [1, "hello", true, null, 42.5];

const largeArray = Array.from({ length: 200 }, (_, i) => ({
  id: i,
  name: `item_${i}`,
  value: i * 1.5,
}));

function makeRepeatedSubtrees() {
  const shared = {
    type: "shared-component",
    config: { x: 1, y: 2, z: 3 },
    metadata: { version: "1.0", tags: ["a", "b", "c"] },
  };
  const items = [];
  for (let i = 0; i < 50; i++) {
    items.push({ id: i, component: shared, label: `item_${i}` });
  }
  return { items };
}
const repeatedSubtrees = makeRepeatedSubtrees();

const unclaimedFact = {
  the: "application/json",
  of: "did:key:z6Mktest1234567890",
};

const assertion16KB = {
  the: "application/json",
  of: "did:key:z6Mktest1234567890",
  is: { content: "X".repeat(16 * 1024 - 100), id: "bench-id" },
};

// Warm up both paths to avoid measuring JIT compilation
for (let i = 0; i < 20; i++) {
  legacyRefer(smallObject);
  canonicalRefer(smallObject);
}

// ==========================================================================
// Same-object benchmarks (measures cache effectiveness)
// ==========================================================================

Deno.bench({
  name: "legacy refer() - small object (5 keys, cached)",
  group: "small-object",
  baseline: true,
  fn() {
    legacyRefer(smallObject);
  },
});

Deno.bench({
  name: "canonical refer() - small object (5 keys)",
  group: "small-object",
  fn() {
    canonicalRefer(smallObject);
  },
});

Deno.bench({
  name: "legacy refer() - medium object (15 keys, 2-level, cached)",
  group: "medium-object",
  baseline: true,
  fn() {
    legacyRefer(mediumObject);
  },
});

Deno.bench({
  name: "canonical refer() - medium object (15 keys, 2-level)",
  group: "medium-object",
  fn() {
    canonicalRefer(mediumObject);
  },
});

Deno.bench({
  name: "legacy refer() - large tree (~364 nodes, cached)",
  group: "large-tree",
  baseline: true,
  fn() {
    legacyRefer(largeNestedTree);
  },
});

Deno.bench({
  name: "canonical refer() - large tree (~364 nodes)",
  group: "large-tree",
  fn() {
    canonicalRefer(largeNestedTree);
  },
});

Deno.bench({
  name: "legacy refer() - small array (5 elements, cached)",
  group: "small-array",
  baseline: true,
  fn() {
    legacyRefer(smallArray);
  },
});

Deno.bench({
  name: "canonical refer() - small array (5 elements)",
  group: "small-array",
  fn() {
    canonicalRefer(smallArray);
  },
});

Deno.bench({
  name: "legacy refer() - large array (200 objects, cached)",
  group: "large-array",
  baseline: true,
  fn() {
    legacyRefer(largeArray);
  },
});

Deno.bench({
  name: "canonical refer() - large array (200 objects)",
  group: "large-array",
  fn() {
    canonicalRefer(largeArray);
  },
});

Deno.bench({
  name: "legacy refer() - repeated subtrees (50 items, 1 shared, cached)",
  group: "repeated-subtrees",
  baseline: true,
  fn() {
    legacyRefer(repeatedSubtrees);
  },
});

Deno.bench({
  name: "canonical refer() - repeated subtrees (50 items, 1 shared)",
  group: "repeated-subtrees",
  fn() {
    canonicalRefer(repeatedSubtrees);
  },
});

Deno.bench({
  name: "legacy refer() - unclaimed {the, of} (cached)",
  group: "unclaimed",
  baseline: true,
  fn() {
    legacyRefer(unclaimedFact);
  },
});

Deno.bench({
  name: "canonical refer() - unclaimed {the, of}",
  group: "unclaimed",
  fn() {
    canonicalRefer(unclaimedFact);
  },
});

Deno.bench({
  name: "legacy refer() - 16KB assertion (cached)",
  group: "assertion-16kb",
  baseline: true,
  fn() {
    legacyRefer(assertion16KB);
  },
});

Deno.bench({
  name: "canonical refer() - 16KB assertion",
  group: "assertion-16kb",
  fn() {
    canonicalRefer(assertion16KB);
  },
});

// ==========================================================================
// Fresh-object benchmarks (no cache benefit -- measures raw hashing speed)
// ==========================================================================

function freshSmallObject() {
  return {
    name: "Alice",
    age: 30,
    active: true,
    score: 95.5,
    tag: null,
  };
}

function freshMediumObject() {
  return makeMediumObject();
}

function freshUnclaimedFact() {
  return {
    the: "application/json",
    of: "did:key:z6Mktest1234567890",
  };
}

function freshAssertion16KB() {
  return {
    the: "application/json",
    of: "did:key:z6Mktest1234567890",
    is: { content: "X".repeat(16 * 1024 - 100), id: "bench-id" },
  };
}

Deno.bench({
  name: "legacy refer() - small object (5 keys, fresh)",
  group: "small-object-fresh",
  baseline: true,
  fn(b) {
    const data = freshSmallObject();
    b.start();
    legacyRefer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - small object (5 keys, fresh)",
  group: "small-object-fresh",
  fn(b) {
    const data = freshSmallObject();
    b.start();
    canonicalRefer(data);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  baseline: true,
  fn(b) {
    const data = freshMediumObject();
    b.start();
    legacyRefer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  fn(b) {
    const data = freshMediumObject();
    b.start();
    canonicalRefer(data);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  baseline: true,
  fn(b) {
    const data = freshUnclaimedFact();
    b.start();
    legacyRefer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  fn(b) {
    const data = freshUnclaimedFact();
    b.start();
    canonicalRefer(data);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - 16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  baseline: true,
  fn(b) {
    const data = freshAssertion16KB();
    b.start();
    legacyRefer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - 16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  fn(b) {
    const data = freshAssertion16KB();
    b.start();
    canonicalRefer(data);
    b.end();
  },
});

// ==========================================================================
// Canonical-only: sparse arrays (merkle-reference throws on holes)
// ==========================================================================

const sparseArray = new Array(100);
for (let i = 0; i < 100; i += 3) {
  sparseArray[i] = { index: i, value: `sparse_${i}` };
}

Deno.bench({
  name: "canonicalHash() - sparse array (100 slots, 34 filled)",
  group: "sparse-array",
  fn() {
    canonicalHash(sparseArray);
  },
});

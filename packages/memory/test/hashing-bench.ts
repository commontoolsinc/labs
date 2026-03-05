/**
 * Hashing Performance Benchmarks: Legacy (merkle-reference) vs. Canonical
 *
 * Compares the two hashing paths used by `refer()`:
 * - Legacy: merkle-reference tree builder with primitive LRU + WeakMap caching
 * - Canonical: `canonicalHash()` single-pass incremental SHA-256
 *
 * Uses `setCanonicalHashConfig()` with `BenchContext.start()` to exclude
 * config setup from timing.
 *
 * Run with: deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check test/hashing-bench.ts
 */

import { refer, setCanonicalHashConfig } from "../reference.ts";
import { canonicalHash } from "../canonical-hash.ts";

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
  setCanonicalHashConfig(false);
  refer(smallObject);
  setCanonicalHashConfig(true);
  refer(smallObject);
}

// ==========================================================================
// Same-object benchmarks (measures cache effectiveness)
// ==========================================================================

Deno.bench({
  name: "legacy refer() - small object (5 keys, cached)",
  group: "small-object",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(smallObject);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - small object (5 keys)",
  group: "small-object",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(smallObject);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - medium object (15 keys, 2-level, cached)",
  group: "medium-object",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(mediumObject);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - medium object (15 keys, 2-level)",
  group: "medium-object",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(mediumObject);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - large tree (~364 nodes, cached)",
  group: "large-tree",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(largeNestedTree);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - large tree (~364 nodes)",
  group: "large-tree",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(largeNestedTree);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - small array (5 elements, cached)",
  group: "small-array",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(smallArray);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - small array (5 elements)",
  group: "small-array",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(smallArray);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - large array (200 objects, cached)",
  group: "large-array",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(largeArray);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - large array (200 objects)",
  group: "large-array",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(largeArray);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - repeated subtrees (50 items, 1 shared, cached)",
  group: "repeated-subtrees",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(repeatedSubtrees);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - repeated subtrees (50 items, 1 shared)",
  group: "repeated-subtrees",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(repeatedSubtrees);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - unclaimed {the, of} (cached)",
  group: "unclaimed",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(unclaimedFact);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - unclaimed {the, of}",
  group: "unclaimed",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(unclaimedFact);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - 16KB assertion (cached)",
  group: "assertion-16kb",
  baseline: true,
  fn(b) {
    setCanonicalHashConfig(false);
    b.start();
    refer(assertion16KB);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - 16KB assertion",
  group: "assertion-16kb",
  fn(b) {
    setCanonicalHashConfig(true);
    b.start();
    refer(assertion16KB);
    b.end();
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
    setCanonicalHashConfig(false);
    b.start();
    refer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - small object (5 keys, fresh)",
  group: "small-object-fresh",
  fn(b) {
    const data = freshSmallObject();
    setCanonicalHashConfig(true);
    b.start();
    refer(data);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  baseline: true,
  fn(b) {
    const data = freshMediumObject();
    setCanonicalHashConfig(false);
    b.start();
    refer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  fn(b) {
    const data = freshMediumObject();
    setCanonicalHashConfig(true);
    b.start();
    refer(data);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  baseline: true,
  fn(b) {
    const data = freshUnclaimedFact();
    setCanonicalHashConfig(false);
    b.start();
    refer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  fn(b) {
    const data = freshUnclaimedFact();
    setCanonicalHashConfig(true);
    b.start();
    refer(data);
    b.end();
  },
});

Deno.bench({
  name: "legacy refer() - 16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  baseline: true,
  fn(b) {
    const data = freshAssertion16KB();
    setCanonicalHashConfig(false);
    b.start();
    refer(data);
    b.end();
  },
});

Deno.bench({
  name: "canonical refer() - 16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  fn(b) {
    const data = freshAssertion16KB();
    setCanonicalHashConfig(true);
    b.start();
    refer(data);
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

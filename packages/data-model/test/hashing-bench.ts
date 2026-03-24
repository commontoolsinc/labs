/**
 * Hashing Performance Benchmarks: Legacy (merkle-reference) vs. Modern
 *
 * Compares the two hashing paths used by `hashOf()`:
 * - Legacy: merkle-reference tree builder with primitive LRU + WeakMap caching
 * - Modern: `hashOfModern()` single-pass incremental SHA-256
 *
 * Uses `setModernHashConfig()` with `BenchContext.start()`/`b.end()` to
 * exclude config setup and teardown from timing.
 *
 * Run with: deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check test/hashing-bench.ts
 */

import {
  hashOf,
  resetModernHashConfig,
  setModernHashConfig,
} from "../value-hash.ts";
import { hashOfModern } from "../value-hash-modern.ts";
import { deepFreeze } from "../deep-freeze.ts";

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
  setModernHashConfig(false);
  hashOf(smallObject);
  setModernHashConfig(true);
  hashOf(smallObject);
}
resetModernHashConfig();

// ==========================================================================
// Same-object benchmarks (measures cache effectiveness)
// ==========================================================================

Deno.bench({
  name: "legacy hashOf() - small object (5 keys, cached)",
  group: "small-object",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(smallObject);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - small object (5 keys)",
  group: "small-object",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(smallObject);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - medium object (15 keys, 2-level, cached)",
  group: "medium-object",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(mediumObject);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - medium object (15 keys, 2-level)",
  group: "medium-object",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(mediumObject);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - large tree (~364 nodes, cached)",
  group: "large-tree",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(largeNestedTree);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - large tree (~364 nodes)",
  group: "large-tree",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(largeNestedTree);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - small array (5 elements, cached)",
  group: "small-array",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(smallArray);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - small array (5 elements)",
  group: "small-array",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(smallArray);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - large array (200 objects, cached)",
  group: "large-array",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(largeArray);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - large array (200 objects)",
  group: "large-array",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(largeArray);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - repeated subtrees (50 items, 1 shared, cached)",
  group: "repeated-subtrees",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(repeatedSubtrees);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - repeated subtrees (50 items, 1 shared)",
  group: "repeated-subtrees",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(repeatedSubtrees);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - unclaimed {the, of} (cached)",
  group: "unclaimed",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(unclaimedFact);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - unclaimed {the, of}",
  group: "unclaimed",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(unclaimedFact);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - 16KB assertion (cached)",
  group: "assertion-16kb",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(assertion16KB);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - 16KB assertion",
  group: "assertion-16kb",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(assertion16KB);
    b.end();
    resetModernHashConfig();
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
  name: "legacy hashOf() - small object (5 keys, fresh)",
  group: "small-object-fresh",
  baseline: true,
  fn(b) {
    const data = freshSmallObject();
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - small object (5 keys, fresh)",
  group: "small-object-fresh",
  fn(b) {
    const data = freshSmallObject();
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  baseline: true,
  fn(b) {
    const data = freshMediumObject();
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  fn(b) {
    const data = freshMediumObject();
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  baseline: true,
  fn(b) {
    const data = freshUnclaimedFact();
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  fn(b) {
    const data = freshUnclaimedFact();
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - 16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  baseline: true,
  fn(b) {
    const data = freshAssertion16KB();
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - 16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  fn(b) {
    const data = freshAssertion16KB();
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
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
  name: "hashOfModern() - sparse array (100 slots, 34 filled)",
  group: "sparse-array",
  fn() {
    hashOfModern(sparseArray);
  },
});

// ==========================================================================
// Deep-frozen same-object benchmarks (WeakMap cache should activate)
// ==========================================================================

const frozenSmallFlat = deepFreeze({
  name: "Alice",
  age: 30,
  active: true,
  score: 95.5,
  tag: null,
});

const frozenNested = deepFreeze({
  user: { name: "Alice", prefs: { theme: "dark", lang: "en" } },
  scores: { math: 95, science: 88, history: 72 },
  meta: { created: "2026-01-01", version: 3 },
});

const frozenArray = deepFreeze([1, "hello", true, null, 42.5, {
  nested: "val",
}]);

const frozenObjectWithArrays = deepFreeze({
  ids: [1, 2, 3, 4, 5],
  tags: ["alpha", "beta", "gamma"],
  matrix: [[1, 2], [3, 4], [5, 6]],
  label: "container",
});

const frozenLargeTree = deepFreeze(makeLargeNestedTree(6, 3));

// Warm up frozen-object path
for (let i = 0; i < 20; i++) {
  setModernHashConfig(true);
  hashOf(frozenSmallFlat);
  hashOf(frozenLargeTree);
  resetModernHashConfig();
}

Deno.bench({
  name: "legacy hashOf() - frozen small flat (5 keys, cached)",
  group: "frozen-small-flat",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(frozenSmallFlat);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen small flat (5 keys, WeakMap cached)",
  group: "frozen-small-flat",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(frozenSmallFlat);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - frozen nested (3-level, cached)",
  group: "frozen-nested",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(frozenNested);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen nested (3-level, WeakMap cached)",
  group: "frozen-nested",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(frozenNested);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - frozen array (6 elements, cached)",
  group: "frozen-array",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(frozenArray);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen array (6 elements, WeakMap cached)",
  group: "frozen-array",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(frozenArray);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - frozen object+arrays (cached)",
  group: "frozen-obj-arrays",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(frozenObjectWithArrays);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen object+arrays (WeakMap cached)",
  group: "frozen-obj-arrays",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(frozenObjectWithArrays);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - frozen large tree (~364 nodes, cached)",
  group: "frozen-large-tree",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(frozenLargeTree);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen large tree (~364 nodes, WeakMap cached)",
  group: "frozen-large-tree",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(frozenLargeTree);
    b.end();
    resetModernHashConfig();
  },
});

// ==========================================================================
// Deep-frozen fresh-object benchmarks (freeze + hash each iteration)
// ==========================================================================

Deno.bench({
  name: "legacy hashOf() - frozen small flat (fresh)",
  group: "frozen-small-flat-fresh",
  baseline: true,
  fn(b) {
    const data = deepFreeze({
      name: "Alice",
      age: 30,
      active: true,
      score: 95.5,
      tag: null,
    });
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen small flat (fresh)",
  group: "frozen-small-flat-fresh",
  fn(b) {
    const data = deepFreeze({
      name: "Alice",
      age: 30,
      active: true,
      score: 95.5,
      tag: null,
    });
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - frozen nested (fresh)",
  group: "frozen-nested-fresh",
  baseline: true,
  fn(b) {
    const data = deepFreeze({
      user: { name: "Alice", prefs: { theme: "dark", lang: "en" } },
      scores: { math: 95, science: 88, history: 72 },
      meta: { created: "2026-01-01", version: 3 },
    });
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen nested (fresh)",
  group: "frozen-nested-fresh",
  fn(b) {
    const data = deepFreeze({
      user: { name: "Alice", prefs: { theme: "dark", lang: "en" } },
      scores: { math: 95, science: 88, history: 72 },
      meta: { created: "2026-01-01", version: 3 },
    });
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - frozen large tree (fresh)",
  group: "frozen-large-tree-fresh",
  baseline: true,
  fn(b) {
    const data = deepFreeze(makeLargeNestedTree(6, 3));
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen large tree (fresh)",
  group: "frozen-large-tree-fresh",
  fn(b) {
    const data = deepFreeze(makeLargeNestedTree(6, 3));
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

// ==========================================================================
// {the, of} unclaimed-fact pattern benchmarks
// ==========================================================================

const frozenTheOf = Object.freeze({
  the: "application/json" as const,
  of: "did:key:z6Mktest1234567890" as const,
});

// Warm up
for (let i = 0; i < 20; i++) {
  setModernHashConfig(true);
  hashOf(frozenTheOf);
  setModernHashConfig(false);
  hashOf(frozenTheOf);
}
resetModernHashConfig();

Deno.bench({
  name: "legacy hashOf() - frozen {the, of} (cached)",
  group: "frozen-the-of",
  baseline: true,
  fn(b) {
    setModernHashConfig(false);
    b.start();
    hashOf(frozenTheOf);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen {the, of} (WeakMap cached)",
  group: "frozen-the-of",
  fn(b) {
    setModernHashConfig(true);
    b.start();
    hashOf(frozenTheOf);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "legacy hashOf() - frozen {the, of} (fresh)",
  group: "frozen-the-of-fresh",
  baseline: true,
  fn(b) {
    const data = Object.freeze({
      the: "application/json",
      of: "did:key:z6Mktest1234567890",
    });
    setModernHashConfig(false);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

Deno.bench({
  name: "canonical hashOf() - frozen {the, of} (fresh)",
  group: "frozen-the-of-fresh",
  fn(b) {
    const data = Object.freeze({
      the: "application/json",
      of: "did:key:z6Mktest1234567890",
    });
    setModernHashConfig(true);
    b.start();
    hashOf(data);
    b.end();
    resetModernHashConfig();
  },
});

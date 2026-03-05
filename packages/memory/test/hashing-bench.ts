/**
 * Hashing Performance Benchmarks: Legacy (merkle-reference) vs. Canonical
 *
 * Compares the two hashing paths used by `refer()`:
 * - Legacy: merkle-reference tree builder with primitive LRU + WeakMap caching
 * - Canonical: `canonicalHash()` single-pass incremental SHA-256
 *
 * Run with: deno bench --allow-read --allow-write --allow-net --allow-ffi --allow-env --no-check test/hashing-bench.ts
 */

import * as Reference from "merkle-reference";
import { canonicalHash } from "../canonical-hash.ts";
import { sha256 } from "../hash-impl.ts";
import { LRUCache } from "@commontools/utils/cache";

// ---------------------------------------------------------------------------
// Re-create the legacy refer() path exactly as in reference.ts
// (We can't use the module-level `refer` directly because it's flag-gated
// and we want to benchmark both paths side by side.)
// ---------------------------------------------------------------------------

const defaultNodeBuilder = Reference.Tree.createBuilder(Reference.sha256)
  .nodeBuilder;

type TreeBuilder = ReturnType<typeof Reference.Tree.createBuilder>;
type Node = ReturnType<typeof defaultNodeBuilder.toTree>;

const primitiveCache = new LRUCache<unknown, Node>({ capacity: 50_000 });

const isPrimitive = (value: unknown): boolean =>
  value === null || typeof value !== "object";

const wrappedNodeBuilder = {
  toTree(source: unknown, builder: TreeBuilder) {
    if (isPrimitive(source)) {
      const cached = primitiveCache.get(source);
      if (cached) return cached;
      const node = defaultNodeBuilder.toTree(source, builder);
      primitiveCache.put(source, node);
      return node;
    }
    return defaultNodeBuilder.toTree(source, builder);
  },
};

const treeBuilder = Reference.Tree.createBuilder(sha256, wrappedNodeBuilder);

function legacyRefer(source: unknown): unknown {
  return treeBuilder.refer(source);
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

function makeLargeNestedTree(depth: number, breadth: number): unknown {
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
  canonicalHash(smallObject);
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
  name: "canonicalHash() - small object (5 keys)",
  group: "small-object",
  fn() {
    canonicalHash(smallObject);
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
  name: "canonicalHash() - medium object (15 keys, 2-level)",
  group: "medium-object",
  fn() {
    canonicalHash(mediumObject);
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
  name: "canonicalHash() - large tree (~364 nodes)",
  group: "large-tree",
  fn() {
    canonicalHash(largeNestedTree);
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
  name: "canonicalHash() - small array (5 elements)",
  group: "small-array",
  fn() {
    canonicalHash(smallArray);
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
  name: "canonicalHash() - large array (200 objects)",
  group: "large-array",
  fn() {
    canonicalHash(largeArray);
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
  name: "canonicalHash() - repeated subtrees (50 items, 1 shared)",
  group: "repeated-subtrees",
  fn() {
    canonicalHash(repeatedSubtrees);
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
  name: "canonicalHash() - unclaimed {the, of}",
  group: "unclaimed",
  fn() {
    canonicalHash(unclaimedFact);
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
  name: "canonicalHash() - 16KB assertion",
  group: "assertion-16kb",
  fn() {
    canonicalHash(assertion16KB);
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
  name: "canonicalHash() - small object (5 keys, fresh)",
  group: "small-object-fresh",
  fn(b) {
    const data = freshSmallObject();
    b.start();
    canonicalHash(data);
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
  name: "canonicalHash() - medium object (15 keys, fresh)",
  group: "medium-object-fresh",
  fn(b) {
    const data = freshMediumObject();
    b.start();
    canonicalHash(data);
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
  name: "canonicalHash() - unclaimed {the, of} (fresh)",
  group: "unclaimed-fresh",
  fn(b) {
    const data = freshUnclaimedFact();
    b.start();
    canonicalHash(data);
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
  name: "canonicalHash() - 16KB assertion (fresh)",
  group: "assertion-16kb-fresh",
  fn(b) {
    const data = freshAssertion16KB();
    b.start();
    canonicalHash(data);
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

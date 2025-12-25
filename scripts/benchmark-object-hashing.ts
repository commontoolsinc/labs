#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env

/**
 * Benchmark for comparing object hashing strategies.
 *
 * Compares merkle-reference against various alternatives for stable object hashing.
 * Tests different hash functions with merkle-reference and evaluates performance
 * across various data structures.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-env scripts/benchmark-object-hashing.ts
 */

// Import libraries from esm.sh to avoid adding dependencies
// @ts-ignore - dynamic import from esm.sh
const MerkleReference = await import("https://esm.sh/merkle-reference@2.2.0");
// @ts-ignore - dynamic import from esm.sh
const objectHash = await import("https://esm.sh/object-hash@3.0.0");
// @ts-ignore - dynamic import from esm.sh
const hashIt = await import("https://esm.sh/hash-it@6.0.0");
// @ts-ignore - dynamic import from esm.sh
const stableStringify = await import(
  "https://esm.sh/fast-json-stable-stringify@2.1.0"
);
// @ts-ignore - dynamic import from esm.sh
const { sha256 } = await import("https://esm.sh/@noble/hashes@1.4.0/sha256");
// @ts-ignore - dynamic import from esm.sh
const { createSHA256 } = await import("https://esm.sh/hash-wasm@4.11.0");

// Test data structures
const testData = {
  // Small structures
  small: {
    simple: { a: 1, b: 2, c: 3 },
    nested: { a: { b: { c: 1 } } },
    array: [1, 2, 3, 4, 5],
    mixed: { a: [1, 2], b: { c: 3 }, d: "hello" },
  },

  // Large structures
  large: {
    // Wide object (many properties)
    wide: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`key${i}`, i]),
    ),

    // Deep nesting
    deep: (() => {
      let obj: any = { value: "bottom" };
      for (let i = 0; i < 100; i++) {
        obj = { nested: obj };
      }
      return obj;
    })(),

    // Large array
    largeArray: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `item${i}`,
      value: Math.random(),
    })),

    // Sparse array
    sparse: (() => {
      const arr = new Array(1000);
      arr[0] = "first";
      arr[100] = "middle";
      arr[999] = "last";
      return arr;
    })(),

    // Complex nested structure
    complex: {
      users: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `user${i}`,
        profile: {
          age: 20 + (i % 50),
          tags: [`tag${i % 10}`, `tag${(i + 1) % 10}`],
          settings: {
            theme: i % 2 === 0 ? "dark" : "light",
            notifications: i % 3 === 0,
          },
        },
      })),
      metadata: {
        version: "1.0.0",
        timestamp: Date.now(),
        count: 100,
      },
    },
  },
};

// Helper to create different hash functions for merkle-reference
async function createHashFunctions() {
  const functions: Record<string, (data: Uint8Array) => Uint8Array> = {};

  // Noble hashes (default for merkle-reference)
  functions["noble"] = (data: Uint8Array) => sha256(data);

  // hash-wasm
  const hasher = await createSHA256();
  functions["hash-wasm"] = (data: Uint8Array) => {
    hasher.init();
    hasher.update(data);
    return hasher.digest("binary");
  };

  // Node crypto (only in Deno/Node)
  try {
    // @ts-ignore
    const nodeCrypto = await import("node:crypto");
    functions["node:crypto"] = (data: Uint8Array) => {
      return nodeCrypto.createHash("sha256").update(data).digest();
    };
  } catch {
    // Not available in browser
  }

  return functions;
}

// Hashing strategies to benchmark
async function createStrategies() {
  const hashFunctions = await createHashFunctions();
  const strategies: Record<string, (obj: any) => string> = {};

  // merkle-reference with different hash functions
  for (const [name, hashFn] of Object.entries(hashFunctions)) {
    const treeBuilder = MerkleReference.Tree.createBuilder(hashFn);
    strategies[`merkle-reference[${name}]`] = (obj: any) => {
      const ref = treeBuilder.refer(obj);
      return ref.hash.toString();
    };
  }

  // object-hash
  strategies["object-hash"] = (obj: any) => {
    return objectHash.default(obj);
  };

  // hash-it
  strategies["hash-it"] = (obj: any) => {
    return hashIt.default(obj).toString();
  };

  // fast-json-stable-stringify + noble sha256
  strategies["stable-stringify+noble"] = (obj: any) => {
    const str = stableStringify.default(obj);
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hash = sha256(data);
    return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  };

  // JSON.stringify (baseline - NOT stable for property order)
  strategies["JSON.stringify+noble (UNSTABLE)"] = (obj: any) => {
    const str = JSON.stringify(obj);
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hash = sha256(data);
    return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  };

  return strategies;
}

// Benchmark runner
async function benchmark(
  name: string,
  fn: () => void,
  iterations: number = 1000,
): Promise<number> {
  // Warmup
  for (let i = 0; i < Math.min(100, iterations / 10); i++) {
    fn();
  }

  // Actual benchmark
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();

  return end - start;
}

// Test stability (property order shouldn't matter)
function testStability(strategy: (obj: any) => string): boolean {
  const obj1 = { a: 1, b: 2, c: 3 };
  const obj2 = { c: 3, b: 2, a: 1 };
  const obj3 = { b: 2, a: 1, c: 3 };

  const hash1 = strategy(obj1);
  const hash2 = strategy(obj2);
  const hash3 = strategy(obj3);

  return hash1 === hash2 && hash2 === hash3;
}

// Main benchmark
async function main() {
  console.log("=== Object Hashing Benchmark ===\n");
  console.log(
    `Environment: ${
      typeof Deno !== "undefined" ? "Deno" : "Browser/Node"
    }\n`,
  );

  const strategies = await createStrategies();

  // Test stability
  console.log("## Stability Test (property order independence)\n");
  for (const [name, strategy] of Object.entries(strategies)) {
    const stable = testStability(strategy);
    console.log(`${name.padEnd(40)} ${stable ? "✓ STABLE" : "✗ UNSTABLE"}`);
  }
  console.log();

  // Benchmark each strategy on each data structure
  const results: Record<
    string,
    Record<string, { time: number; opsPerSec: number }>
  > = {};

  const testCases = [
    { category: "small", name: "simple", data: testData.small.simple, iterations: 10000 },
    { category: "small", name: "nested", data: testData.small.nested, iterations: 10000 },
    { category: "small", name: "array", data: testData.small.array, iterations: 10000 },
    { category: "small", name: "mixed", data: testData.small.mixed, iterations: 10000 },
    { category: "large", name: "wide", data: testData.large.wide, iterations: 1000 },
    { category: "large", name: "deep", data: testData.large.deep, iterations: 1000 },
    {
      category: "large",
      name: "largeArray",
      data: testData.large.largeArray,
      iterations: 100,
    },
    { category: "large", name: "sparse", data: testData.large.sparse, iterations: 1000 },
    { category: "large", name: "complex", data: testData.large.complex, iterations: 100 },
  ];

  for (const testCase of testCases) {
    console.log(`\n## ${testCase.category}/${testCase.name}\n`);

    for (const [strategyName, strategy] of Object.entries(strategies)) {
      try {
        const time = await benchmark(
          strategyName,
          () => strategy(testCase.data),
          testCase.iterations,
        );
        const opsPerSec = (testCase.iterations / time) * 1000;

        if (!results[strategyName]) {
          results[strategyName] = {};
        }
        results[strategyName][`${testCase.category}/${testCase.name}`] = {
          time,
          opsPerSec,
        };

        console.log(
          `${strategyName.padEnd(40)} ${time.toFixed(2)}ms (${
            opsPerSec.toFixed(0)
          } ops/sec)`,
        );
      } catch (err) {
        console.log(`${strategyName.padEnd(40)} ERROR: ${err.message}`);
      }
    }
  }

  // Summary table
  console.log("\n\n=== SUMMARY (ops/sec - higher is better) ===\n");

  const strategyNames = Object.keys(strategies);
  const testNames = testCases.map((t) => `${t.category}/${t.name}`);

  // Header
  console.log(
    "Strategy".padEnd(40) +
      testNames
        .map((n) => {
          const short = n.split("/")[1].substring(0, 10);
          return short.padEnd(12);
        })
        .join(""),
  );
  console.log("-".repeat(40 + testNames.length * 12));

  // Rows
  for (const strategyName of strategyNames) {
    const row = strategyName.padEnd(40);
    const values = testNames.map((testName) => {
      const result = results[strategyName]?.[testName];
      if (!result) return "N/A".padEnd(12);
      const opsPerSec = result.opsPerSec;
      if (opsPerSec > 1000000) {
        return `${(opsPerSec / 1000000).toFixed(1)}M`.padEnd(12);
      } else if (opsPerSec > 1000) {
        return `${(opsPerSec / 1000).toFixed(1)}K`.padEnd(12);
      } else {
        return `${opsPerSec.toFixed(0)}`.padEnd(12);
      }
    });
    console.log(row + values.join(""));
  }

  console.log("\n=== DONE ===\n");
}

// Run if executed directly
if (import.meta.main) {
  main();
}

export { benchmark, createStrategies, testData, testStability };

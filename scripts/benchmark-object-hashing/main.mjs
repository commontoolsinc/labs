#!/usr/bin/env node

/**
 * Node.js runner for the object hashing benchmark.
 *
 * Usage:
 *   node scripts/benchmark-object-hashing-node.mjs
 */

// Import libraries from esm.sh/npm
const [
  MerkleReference,
  objectHash,
  hashIt,
  stableStringify,
  { sha256 },
  { blake2b },
  { createSHA256 },
  dagCbor,
  { CID },
  multihash,
] = await Promise.all([
  import("https://esm.sh/merkle-reference@2.2.0").catch(() =>
    import("merkle-reference")
  ),
  import("https://esm.sh/object-hash@3.0.0").catch(() => import("object-hash")),
  import("https://esm.sh/hash-it@6.0.0").catch(() => import("hash-it")),
  import("https://esm.sh/fast-json-stable-stringify@2.1.0").catch(() =>
    import("fast-json-stable-stringify")
  ),
  import("https://esm.sh/@noble/hashes@1.4.0/sha256").catch(() =>
    import("@noble/hashes/sha256")
  ),
  import("https://esm.sh/@noble/hashes@1.4.0/blake2b").catch(() =>
    import("@noble/hashes/blake2b")
  ),
  import("https://esm.sh/hash-wasm@4.11.0").catch(() => import("hash-wasm")),
  import("https://esm.sh/@ipld/dag-cbor@9.2.1").catch(() =>
    import("@ipld/dag-cbor")
  ),
  import("https://esm.sh/multiformats@13.3.2/cid").catch(() =>
    import("multiformats/cid")
  ),
  import("https://esm.sh/multiformats@13.3.2/hashes/digest").catch(() =>
    import("multiformats/hashes/digest")
  ),
]);

// Create a 256-bit blake2b hasher
const blake2b256 = (data) => blake2b(data, { dkLen: 32 });

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
    wide: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`key${i}`, i]),
    ),
    deep: (() => {
      let obj = { value: "bottom" };
      for (let i = 0; i < 100; i++) {
        obj = { nested: obj };
      }
      return obj;
    })(),
    largeArray: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `item${i}`,
      value: Math.random(),
    })),
    sparse: (() => {
      const arr = new Array(1000);
      arr[0] = "first";
      arr[100] = "middle";
      arr[999] = "last";
      return arr;
    })(),
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

async function createHashFunctions() {
  const functions = {};

  functions["noble"] = (data) => sha256(data);

  const hasher = await createSHA256();
  functions["hash-wasm"] = (data) => {
    hasher.init();
    hasher.update(data);
    return hasher.digest("binary");
  };

  try {
    const nodeCrypto = await import("node:crypto");
    functions["node:crypto"] = (data) => {
      return nodeCrypto.createHash("sha256").update(data).digest();
    };
  } catch {
    // Not available
  }

  return functions;
}

async function createStrategies() {
  const hashFunctions = await createHashFunctions();
  const strategies = {};

  for (const [name, hashFn] of Object.entries(hashFunctions)) {
    const treeBuilder = MerkleReference.Tree.createBuilder(hashFn);
    strategies[`merkle-reference[${name}]`] = (obj) => {
      const ref = treeBuilder.refer(obj);
      return ref.hash.toString();
    };
  }

  strategies["object-hash"] = (obj) => {
    return objectHash.default ? objectHash.default(obj) : objectHash(obj);
  };

  strategies["hash-it"] = (obj) => {
    const hashFn = hashIt.default || hashIt;
    return hashFn(obj).toString();
  };

  strategies["stable-stringify+noble"] = (obj) => {
    const stringify = stableStringify.default || stableStringify;
    const str = stringify(obj);
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hash = sha256(data);
    return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  };

  strategies["JSON.stringify+noble (UNSTABLE)"] = (obj) => {
    const str = JSON.stringify(obj);
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hash = sha256(data);
    return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  };

  // DAG-CBOR approaches
  strategies["dag-cbor+sha256"] = (obj) => {
    const encode = dagCbor.encode || dagCbor;
    const encoded = encode(obj);
    const hash = sha256(encoded);
    return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  };

  strategies["dag-cbor+blake2b"] = (obj) => {
    const encode = dagCbor.encode || dagCbor;
    const encoded = encode(obj);
    const hash = blake2b256(encoded);
    return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
  };

  strategies["dag-cbor+CID"] = (obj) => {
    const encode = dagCbor.encode || dagCbor;
    const encoded = encode(obj);
    const hash = sha256(encoded);
    const digest = multihash.create(0x12, hash);
    const cid = CID.createV1(0x71, digest);
    return cid.toString();
  };

  return strategies;
}

function benchmark(fn, iterations = 1000) {
  for (let i = 0; i < Math.min(100, iterations / 10); i++) {
    fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();

  return end - start;
}

function testStability(strategy) {
  const obj1 = { a: 1, b: 2, c: 3 };
  const obj2 = { c: 3, b: 2, a: 1 };
  const obj3 = { b: 2, a: 1, c: 3 };

  const hash1 = strategy(obj1);
  const hash2 = strategy(obj2);
  const hash3 = strategy(obj3);

  return hash1 === hash2 && hash2 === hash3;
}

async function main() {
  console.log("=== Object Hashing Benchmark ===\n");
  console.log("Environment: Node.js\n");

  const strategies = await createStrategies();

  console.log("## Stability Test (property order independence)\n");
  for (const [name, strategy] of Object.entries(strategies)) {
    const stable = testStability(strategy);
    console.log(`${name.padEnd(40)} ${stable ? "✓ STABLE" : "✗ UNSTABLE"}`);
  }
  console.log();

  const results = {};

  const testCases = [
    {
      category: "small",
      name: "simple",
      data: testData.small.simple,
      iterations: 10000,
    },
    {
      category: "small",
      name: "nested",
      data: testData.small.nested,
      iterations: 10000,
    },
    {
      category: "small",
      name: "array",
      data: testData.small.array,
      iterations: 10000,
    },
    {
      category: "small",
      name: "mixed",
      data: testData.small.mixed,
      iterations: 10000,
    },
    {
      category: "large",
      name: "wide",
      data: testData.large.wide,
      iterations: 1000,
    },
    {
      category: "large",
      name: "deep",
      data: testData.large.deep,
      iterations: 1000,
    },
    {
      category: "large",
      name: "largeArray",
      data: testData.large.largeArray,
      iterations: 100,
    },
    {
      category: "large",
      name: "sparse",
      data: testData.large.sparse,
      iterations: 1000,
    },
    {
      category: "large",
      name: "complex",
      data: testData.large.complex,
      iterations: 100,
    },
  ];

  for (const testCase of testCases) {
    console.log(`\n## ${testCase.category}/${testCase.name}\n`);

    for (const [strategyName, strategy] of Object.entries(strategies)) {
      try {
        const time = await benchmark(
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

  console.log("\n\n=== SUMMARY (ops/sec - higher is better) ===\n");

  const strategyNames = Object.keys(strategies);
  const testNames = testCases.map((t) => `${t.category}/${t.name}`);

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

main().catch(console.error);

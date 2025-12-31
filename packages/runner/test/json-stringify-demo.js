// Standalone demo of JSON.stringify performance issue
// Run with: deno run json-stringify-demo.js

const space = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

// Create a realistic schema like what's used in the codebase
const complexSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    user: {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        email: { type: "string" },
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
          },
        },
        preferences: {
          type: "object",
          properties: {
            theme: { type: "string" },
            notifications: { type: "boolean" },
            privacy: {
              type: "object",
              properties: {
                profile: { type: "string" },
                activity: { type: "string" },
              },
            },
          },
        },
      },
    },
    tags: {
      type: "array",
      items: { type: "string" },
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
};

const link = {
  space,
  id: "test-doc",
  type: "application/json",
  path: ["user", "address"],
  schema: complexSchema,
  rootSchema: complexSchema,
};

console.log("\n=== JSON.stringify Performance Demo ===\n");
console.log("This simulates what happens in schema.ts:379 during Cell.get()\n");

// Warmup
for (let i = 0; i < 10; i++) {
  JSON.stringify(link);
}

// Measure 100 stringify calls
console.log("Measuring 100 JSON.stringify() calls on link object with schema...");
const start = performance.now();
for (let i = 0; i < 100; i++) {
  JSON.stringify(link);
}
const end = performance.now();

const totalTime = end - start;
const avgTime = totalTime / 100;
const stringified = JSON.stringify(link);

console.log(`\nResults:`);
console.log(`  Total time for 100 calls: ${totalTime.toFixed(3)}ms`);
console.log(`  Average per call: ${avgTime.toFixed(3)}ms`);
console.log(`  Stringified size: ${stringified.length} characters`);

console.log(`\n=== Extrapolation to Real Scenario ===\n`);
console.log(`For a nested structure with 10 docs (creates ~50 cells):`);
console.log(`  50 cells × ${avgTime.toFixed(3)}ms = ${(avgTime * 50).toFixed(1)}ms just for JSON.stringify`);

console.log(`\n=== Linear Search (.find()) Overhead ===\n`);

// Simulate the seen array growing
const seen = [];
for (let i = 0; i < 50; i++) {
  const testLink = {
    space,
    id: `doc-${i}`,
    type: "application/json",
    path: [],
    schema: { type: "object", properties: { value: { type: "number" } } },
  };
  seen.push([JSON.stringify(testLink), { value: i }]);
}

const lookupKey = JSON.stringify({
  space,
  id: "not-found",
  type: "application/json",
  path: [],
  schema: { type: "object" },
});

console.log(`Measuring 100 .find() lookups in array of ${seen.length} items (worst case - not found)...`);
const findStart = performance.now();
for (let i = 0; i < 100; i++) {
  seen.find((entry) => entry[0] === lookupKey);
}
const findEnd = performance.now();

const findTotal = findEnd - findStart;
const findAvg = findTotal / 100;

console.log(`\nResults:`);
console.log(`  Total time for 100 lookups: ${findTotal.toFixed(3)}ms`);
console.log(`  Average per lookup: ${findAvg.toFixed(3)}ms`);

console.log(`\n=== Total Estimated Overhead ===\n`);
const estimatedStringify = avgTime * 50;
const estimatedFind = findAvg * 50; // Each cell does a lookup
const estimatedTotal = estimatedStringify + estimatedFind;

console.log(`  JSON.stringify: ~${estimatedStringify.toFixed(1)}ms`);
console.log(`  Linear .find(): ~${estimatedFind.toFixed(1)}ms`);
console.log(`  Other operations: ~2-3ms`);
console.log(`  ───────────────────────────`);
console.log(`  TOTAL: ~${estimatedTotal.toFixed(1)}-${(estimatedTotal + 3).toFixed(1)}ms`);

console.log(`\n=== Comparison with Map ===\n`);

// Show how much faster a Map would be
const seenMap = new Map();
for (let i = 0; i < 50; i++) {
  const testLink = {
    space,
    id: `doc-${i}`,
    type: "application/json",
    path: [],
    schema: { type: "object", properties: { value: { type: "number" } } },
  };
  seenMap.set(JSON.stringify(testLink), { value: i });
}

console.log(`Measuring 100 Map.has() lookups...`);
const mapStart = performance.now();
for (let i = 0; i < 100; i++) {
  seenMap.has(lookupKey);
}
const mapEnd = performance.now();

const mapTotal = mapEnd - mapStart;
const mapAvg = mapTotal / 100;

console.log(`\nResults:`);
console.log(`  Total time for 100 lookups: ${mapTotal.toFixed(3)}ms`);
console.log(`  Average per lookup: ${mapAvg.toFixed(3)}ms`);
console.log(`  Speedup vs Array.find(): ${(findAvg / mapAvg).toFixed(1)}x faster`);

console.log(`\n=== Recommendation ===\n`);
console.log(`Change schema.ts line 334 from:`);
console.log(`  seen: Array<[string, any]> = []`);
console.log(`To:`);
console.log(`  seen: Map<string, any> = new Map()`);
console.log(`\nAnd update lines 379-383 to use Map.get() instead of .find()`);
console.log(`\nThis alone would save ~${(estimatedFind - mapAvg * 50).toFixed(1)}ms per read!`);

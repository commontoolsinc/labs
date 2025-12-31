import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

/**
 * Test to verify JSON.stringify() performance issue in validateAndTransform
 *
 * Hypothesis: For nested structures with schemas, the repeated JSON.stringify(link)
 * calls in schema.ts:379 are expensive, especially when schemas are large.
 */

const signer = await Identity.fromPassphrase("stringify perf test");
const space = signer.did();

describe("Schema stringify performance", () => {
  it("should measure JSON.stringify overhead on link objects", () => {
    // Create a realistic schema like what might be used
    const complexSchema: JSONSchema = {
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

    console.log("\n=== Measuring JSON.stringify on link object ===");

    // Warmup
    for (let i = 0; i < 10; i++) {
      JSON.stringify(link);
    }

    // Measure 100 stringify calls
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      JSON.stringify(link);
    }
    const end = performance.now();

    const avgTime = (end - start) / 100;
    console.log(`100 JSON.stringify calls: ${(end - start).toFixed(3)}ms`);
    console.log(`Average per call: ${avgTime.toFixed(3)}ms`);
    console.log(`Stringified size: ${JSON.stringify(link).length} characters`);

    // Extrapolate to 50 cells (typical nested structure)
    console.log(
      `\nFor 50 cells in nested structure: ~${(avgTime * 50).toFixed(1)}ms just for JSON.stringify`,
    );
  });

  it("should measure seen array .find() overhead", () => {
    const seen: Array<[string, any]> = [];

    // Simulate building up the seen array as we process cells
    for (let i = 0; i < 50; i++) {
      const link = {
        space,
        id: `doc-${i}`,
        type: "application/json",
        path: [],
        schema: { type: "object" },
      };
      seen.push([JSON.stringify(link), { value: i }]);
    }

    console.log("\n=== Measuring seen.find() overhead ===");

    // Now measure lookups (worst case - not found)
    const testLink = {
      space,
      id: "not-in-seen",
      type: "application/json",
      path: [],
      schema: { type: "object" },
    };
    const testKey = JSON.stringify(testLink);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      seen.find((entry) => entry[0] === testKey);
    }
    const end = performance.now();

    console.log(`100 lookups in array of ${seen.length}: ${(end - start).toFixed(3)}ms`);
    console.log(`Average per lookup: ${((end - start) / 100).toFixed(3)}ms`);
  });

  it("should measure actual nested structure read performance", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const schema: JSONSchema = {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        nested: {
          type: "object",
          asCell: true,  // Force cell creation
        },
      },
    };

    // Create 10 documents with schema
    const tx = runtime.edit();
    const docs = [];
    for (let i = 0; i < 10; i++) {
      const doc = runtime.getCell(space, `doc-${i}`, schema, tx);
      doc.set({
        id: i,
        name: `Doc ${i}`,
        nested: { value: i * 10 },
      });
      docs.push(doc);
    }

    const root = runtime.getCell(space, "root", {
      type: "object",
      properties: {
        docs: {
          type: "array",
          items: schema,
        },
      },
    }, tx);
    root.set({ docs });

    // Test BEFORE commit (fast - in transaction)
    console.log("\n=== Reading BEFORE commit ===");
    const beforeStart = performance.now();
    const beforeValue = root.get();
    const beforeEnd = performance.now();
    console.log(`Time: ${(beforeEnd - beforeStart).toFixed(3)}ms`);

    await tx.commit();

    // Test AFTER commit (data in nursery with pending write)
    console.log("\n=== Reading AFTER commit (in nursery, write pending) ===");
    const afterStart = performance.now();
    const afterValue = root.get();
    const afterEnd = performance.now();
    console.log(`Time: ${(afterEnd - afterStart).toFixed(3)}ms`);
    console.log(`Slowdown: ${((afterEnd - afterStart) / (beforeEnd - beforeStart)).toFixed(1)}x`);

    await runtime.dispose();
    await storageManager.close();
  });
});

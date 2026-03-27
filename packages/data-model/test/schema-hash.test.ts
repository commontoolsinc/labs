import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  findInternedSchema,
  hashSchema,
  hashSchemaItem,
  internSchema,
  resetSchemaHashConfig,
  setSchemaHashConfig,
} from "../schema-hash.ts";
import { SchemaAndHash } from "../schema-and-hash.ts";
import { FabricHash } from "../fabric-hash.ts";
import { isDeepFrozen } from "../deep-freeze.ts";
import { toDeepFrozenSchema } from "../schema-utils.ts";
import type { JSONSchema, JSONSchemaObj } from "@commontools/api";

describe("schema-hash dispatch", () => {
  afterEach(() => {
    resetSchemaHashConfig();
  });

  for (const modernHashConfig of [false, true]) {
    describe(`with \`modernSchemaHash = ${modernHashConfig}\``, () => {
      beforeEach(() => {
        // Note: This clears the intern cache, meaning we can count on
        // not-finding things that might have otherwise been around from other
        // tests.
        setSchemaHashConfig(modernHashConfig);
      });

      describe("hashSchema()", () => {
        it("returns a string", () => {
          const result = hashSchema({ type: "number" });
          assertStrictEquals(typeof result, "string");
        });

        it("is deterministic (same input produces same result)", () => {
          const schema: JSONSchema = {
            type: "object",
            properties: { name: { type: "string" } },
          };
          const a = hashSchema(schema);
          const b = hashSchema(schema);
          assertStrictEquals(a, b);
        });

        it("produces different results for different schemas", () => {
          const a = hashSchema({ type: "number" });
          const b = hashSchema({ type: "string" });
          assertNotEquals(a, b);
        });

        it("is key-order independent", () => {
          const a = hashSchema({ type: "object", title: "A" } as JSONSchema);
          const b = hashSchema({ title: "A", type: "object" } as JSONSchema);
          assertStrictEquals(a, b);
        });
      });

      describe("hashSchemaItem()", () => {
        it("returns a string", () => {
          const result = hashSchemaItem("hello");
          assertStrictEquals(typeof result, "string");
        });

        it("is deterministic", () => {
          const a = hashSchemaItem(42);
          const b = hashSchemaItem(42);
          assertStrictEquals(a, b);
        });

        it("produces different results for different values", () => {
          const a = hashSchemaItem("foo");
          const b = hashSchemaItem("bar");
          assertNotEquals(a, b);
        });
      });

      describe("internSchema()", () => {
        it("defaults to `wantSchemaAndHash = false`", () => {
          const result = internSchema({});
          assert(!(result instanceof SchemaAndHash));
        });

        for (const wantSah of [false, true]) {
          const callIntern = (schema: JSONSchema, fullResult = false) => {
            const result = internSchema(schema, wantSah);

            if (wantSah) {
              assert(result instanceof SchemaAndHash);
              assert(result.hash instanceof FabricHash);
              return fullResult ? result : result.schema;
            } else {
              return result;
            }
          };

          describe(`with \`wantSchemaAndHash = ${wantSah}\``, () => {
            it("creates a valid result with schema equal to the given one", () => {
              const result = callIntern({ type: "number" });
              assertEquals(result, { type: "number" });
            });

            it("returns a deep-frozen schema result", () => {
              const schema: JSONSchemaObj = {
                type: "object",
                properties: { name: { type: "string" } },
              };
              const result = callIntern(schema);
              assert(isDeepFrozen(result));
            });

            it("deep-freezes the caller's original if not already deep-frozen", () => {
              const schema: JSONSchemaObj = {
                type: "object",
                properties: { x: { type: "number" } },
              };
              callIntern(schema);
              assert(isDeepFrozen(schema));
            });

            it("uses an already-deep-frozen schema by reference", () => {
              const schema = toDeepFrozenSchema({
                type: "object",
                properties: { uniqueField: { type: "boolean" } },
              }) as JSONSchemaObj;
              assert(isDeepFrozen(schema));
              const result = callIntern(schema);
              assertStrictEquals(result, schema);
            });

            it("uses a never-before-encountered mutable schema by reference", () => {
              const schema = {
                type: "number",
                properties: { uniqueField: { type: "boolean" } },
              } as JSONSchemaObj;
              const result = callIntern(schema);
              assertStrictEquals(result, schema);
            });

            it("handles boolean schema true", () => {
              const result = callIntern(true);
              assertEquals(result, true);
            });

            it("handles boolean schema false", () => {
              const result = callIntern(false);
              assertEquals(result, false);
            });

            it("handles empty object schema", () => {
              const result = callIntern({});
              assertEquals(result, {});
            });

            it("returns same instance for repeated boolean schema", () => {
              const result1 = callIntern(true, true);
              const result2 = callIntern(true, true);
              assertStrictEquals(result1, result2);
            });

            it("returns same instance for same frozen object schema", () => {
              const schema = toDeepFrozenSchema({
                type: "number",
              }) as JSONSchemaObj;
              const result1 = callIntern(schema, true);
              const result2 = callIntern(schema, true);
              assertStrictEquals(result1, result2);
            });

            it("returns same instance for repeated unfrozen schema", () => {
              const result1 = callIntern({ type: "number" }, true);
              const result2 = callIntern({ type: "number" }, true);
              assertStrictEquals(result1, result2);
            });

            it("different schemas produce different instances", () => {
              const result1 = callIntern({ type: "number" }, true);
              const result2 = callIntern({ type: "string" }, true);
              assertNotStrictEquals(result1, result2);
            });

            it("property order does not affect interning", () => {
              const result1 = callIntern(
                { type: "object", title: "foo" },
                true,
              );
              const result2 = callIntern(
                { title: "foo", type: "object" },
                true,
              );
              assertStrictEquals(result1, result2);
            });

            it("structurally-equal but identity-different schemas return same instance", () => {
              const a: JSONSchemaObj = {
                type: "object",
                properties: { x: { type: "number" } },
              };
              const b: JSONSchemaObj = {
                type: "object",
                properties: { x: { type: "number" } },
              };
              assertNotStrictEquals(a, b); // different objects
              const resultA = callIntern(a, true);
              const resultB = callIntern(b, true);
              assertStrictEquals(resultA, resultB);
            });
          });
        }
      });

      describe("findInternedSchema()", () => {
        it("defaults to `wantSchemaAndHash = false`", () => {
          const hash = internSchema({}, true).hash;
          const result = findInternedSchema(hash);
          assert(result !== undefined);
          assert(!(result instanceof SchemaAndHash));
        });

        for (const wantSah of [false, true]) {
          const callFind = (hash: FabricHash | string) => {
            const result = findInternedSchema(hash, wantSah);

            if (wantSah && (result !== undefined)) {
              assert(result instanceof SchemaAndHash);
              assert(result.hash instanceof FabricHash);
            }

            return result;
          };

          const expectSame = (
            got: JSONSchema | SchemaAndHash | undefined,
            expectedSah: SchemaAndHash,
          ) => {
            if (wantSah) {
              assertStrictEquals(got, expectedSah);
            } else {
              assertStrictEquals(got, expectedSah.schema);
            }
          };

          describe(`with \`wantSchemaAndHash = ${wantSah}\``, () => {
            it("finds a previously interned schema by FabricHash", () => {
              const sah = internSchema(
                { type: "array", items: { type: "string" } },
                true,
              );
              const found = callFind(sah.hash);
              expectSame(found, sah);
            });

            it("finds a previously interned schema by hash string", () => {
              const sah = internSchema(
                {
                  type: "object",
                  properties: { z: { type: "boolean" } },
                },
                true,
              );
              const found = callFind(sah.hashString);
              expectSame(found, sah);
            });

            it("returns undefined for unknown hash", () => {
              const unknown = new FabricHash(new Uint8Array(32), "fid1");
              const found = callFind(unknown);
              assertStrictEquals(found, undefined);
            });

            it("finds interned boolean schemas", () => {
              const sahTrue = internSchema(true, true);
              const sahFalse = internSchema(false, true);
              const foundTrue = callFind(sahTrue.hash);
              const foundFalse = callFind(sahFalse.hash);
              expectSame(foundTrue, sahTrue);
              expectSame(foundFalse, sahFalse);
            });
          });
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Extra tests for modern hashes (flag ON)
  // -------------------------------------------------------------------------

  describe("with `modernSchemaHash = true`", () => {
    it("hashSchema returns fid1: prefixed strings", () => {
      setSchemaHashConfig(true);
      const result = hashSchema({ type: "number" });
      assert(
        result.startsWith("fid1:"),
        `Expected fid1: prefix, got: ${result}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cross-path: legacy and modern produce different hashes
  // -------------------------------------------------------------------------

  describe("legacy vs modern produce different hashes", () => {
    it("hashSchema differs between paths for same input", () => {
      const schema: JSONSchema = { type: "number" };
      setSchemaHashConfig(false);
      const legacy = hashSchema(schema);
      setSchemaHashConfig(true);
      const modern = hashSchema(schema);
      assertNotEquals(legacy, modern);
    });

    it("hashSchemaItem differs between paths for same input", () => {
      setSchemaHashConfig(false);
      const legacy = hashSchemaItem("test");
      setSchemaHashConfig(true);
      const modern = hashSchemaItem("test");
      assertNotEquals(legacy, modern);
    });
  });

  // -------------------------------------------------------------------------
  // Reset behavior
  // -------------------------------------------------------------------------

  describe("reset restores legacy path", () => {
    it("hashSchema returns legacy result after reset", () => {
      setSchemaHashConfig(false);
      const legacy = hashSchema({ type: "boolean" });

      setSchemaHashConfig(true);
      resetSchemaHashConfig();
      const afterReset = hashSchema({ type: "boolean" });

      assertStrictEquals(legacy, afterReset);
    });
  });
});

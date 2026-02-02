import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";
import { isObject } from "@commontools/utils/types";

const signer = await Identity.fromPassphrase("test operator");

describe("OpaqueRef Schema Support", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let cell: ReturnType<typeof createBuilder>["commontools"]["cell"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const { commontools } = createBuilder();
    ({ recipe, cell } = commontools);
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  describe("Schema Setting and Retrieval", () => {
    it("should store and retrieve schema information", () => {
      // Set a schema
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      } as const satisfies JSONSchema;

      // Create an opaque ref
      const ref = cell<{ name: string; age: number }>(undefined, schema);

      // Export the ref and check the schema is included
      const exported = ref.export();
      expect(exported.schema).toBeDefined();
      expect(exported.schema).toEqual(schema);
    });

    it("should handle narrowed schema with keys", () => {
      // Set a schema with root schema
      const fullSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          details: {
            type: "object",
            properties: {
              age: { type: "number" },
            },
          },
        },
      } as const satisfies JSONSchema;

      // Create an opaque ref
      const ref = cell<{ name: string; details: { age: number } }>(
        undefined,
        fullSchema,
      ).key("details");

      // Export the ref and check both schemas are included
      const exported = ref.export();
      expect(exported.schema).toBeDefined();
      expect(exported.schema).toEqual(fullSchema.properties.details);
    });
  });

  describe("Schema Propagation in Proxies", () => {
    it("should propagate schema to child properties via key()", () => {
      // Set a schema
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      } as const satisfies JSONSchema;

      // Create an opaque ref
      const ref = cell<{ name: string; age: number }>(undefined, schema);

      // Get a child property
      const nameRef = ref.key("name");

      // Export the child ref and check it has the correct schema
      const exported = nameRef.export();
      expect(exported.schema).toBeDefined();
      expect(exported.schema).toEqual({ type: "string" });
    });

    it("should propagate schema to array elements", () => {
      // Set a schema
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                text: { type: "string" },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      // Create an opaque ref with an array
      const ref = cell<{ items: Array<{ id: number; text: string }> }>(
        undefined,
        schema,
      );

      // Access array element
      const itemsRef = ref.key("items");
      const firstItemRef = itemsRef.key(0);
      const idRef = firstItemRef.key("id");

      // Check schema for array element property
      const exported = idRef.export();
      expect(exported.schema).toBeDefined();
      expect(exported.schema).toEqual({ type: "number" });
    });

    it("should handle nested object schemas correctly", () => {
      // Set a schema with nested objects
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  settings: {
                    type: "object",
                    properties: {
                      theme: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      // Create an opaque ref with nested objects
      const ref = cell<{
        user: {
          profile: {
            name: string;
            settings: {
              theme: string;
            };
          };
        };
      }>(undefined, schema);

      // Access deeply nested property
      const themeRef = ref.key("user").key("profile").key("settings").key(
        "theme",
      );

      // Check schema was correctly propagated
      const exported = themeRef.export();
      expect(exported.schema).toBeDefined();
      expect(exported.schema).toEqual({ type: "string" });
    });

    it("should handle full object schemas correctly", () => {
      // Set a schema with nested objects
      const schema = {
        type: "object",
        properties: {
          details: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
          },
        },
      } as const satisfies JSONSchema;

      // Create an opaque ref with nested objects
      const ref = cell<{
        details: {
          name: string;
          age: number;
        };
      }>(undefined, schema);

      // Access deeply nested property
      const detailsRef = ref.key("details");

      // Check schema was correctly propagated
      const exported = detailsRef.export();
      expect(exported.schema).toBeDefined();
      expect(exported.schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      });
    });

    it("should return undefined schema for properties that aren't allowed by the schema", () => {
      // Set a schema with nested objects
      const schema = {
        type: "object",
        properties: {
          details: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
          },
        },
        additionalProperties: false,
      } as const satisfies JSONSchema;

      // Create an opaque ref with nested objects, and a property that isn't in the schema
      const ref = cell<{
        details: {
          name: string;
          age: number;
        };
        nickname: string;
      }>(undefined, schema);

      // Access nested property that's not part of the schema
      const nicknameRef = ref.key("nickname");

      // Check schema is undefined for this field that isn't in the schema
      const exported = nicknameRef.export();
      expect(exported.schema).toBeUndefined();
    });
  });

  describe("Schema in Recipe Context", () => {
    it("should initialize opaque refs with schema from argument schema", () => {
      // Create a recipe with schema
      const testRecipe = recipe(
        {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
        },
        (input) => {
          // Directly return the input
          return input;
        },
      );

      expect((testRecipe.result as any).$alias).toBeDefined();
      const alias = (testRecipe.result as any).$alias;

      // Check that schema was set
      expect(alias.schema).toBeDefined();
      expect(alias.schema.type).toBe("object");
      expect(alias.schema.properties?.name).toEqual({ type: "string" });
      expect(alias.schema.properties?.age).toEqual({ type: "number" });
    });

    it("should track schema through recipe bindings", () => {
      // Create a recipe that uses child properties
      const testRecipe = recipe(
        {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                name: { type: "string" },
                details: {
                  type: "object",
                  properties: {
                    age: { type: "number" },
                  },
                },
              },
            },
          },
        } as const satisfies JSONSchema,
        (input) => {
          // Get a nested property
          // TODO(seefeld): Fix type inference
          const age = (input as any).user.details.age;

          // Export both the original ref and nested property
          return {
            age,
          };
        },
      );

      expect((testRecipe.result as any).age?.$alias).toBeDefined();
      const alias = (testRecipe.result as any).age.$alias;

      // Check the age property schema
      expect(alias.schema).toBeDefined();
      expect(alias.schema).toEqual({ type: "number" });
    });
  });

  describe("Schema $ref and $defs Resolution", () => {
    it("should preserve rootSchema with $defs when navigating with key()", () => {
      // Schema with $defs that needs to be preserved for nested $ref resolution
      const schema = {
        $defs: {
          Address: {
            type: "object",
            properties: {
              street: { type: "string" },
              city: { type: "string" },
            },
          },
          Person: {
            type: "object",
            properties: {
              name: { type: "string" },
              home: { $ref: "#/$defs/Address" },
            },
          },
        },
        type: "object",
        properties: {
          user: { $ref: "#/$defs/Person" },
        },
      } as const satisfies JSONSchema;

      // Create a cell with this schema
      const ref = cell<{
        user: {
          name: string;
          home: {
            street: string;
            city: string;
          };
        };
      }>(undefined, schema);

      // Navigate to user
      const userRef = ref.key("user");
      const userExport = userRef.export();

      // The rootSchema should be preserved (contains $defs)
      expect(userExport.schema).toBeDefined();
      expect((userExport.schema as any).$defs).toBeDefined();
      expect((userExport.schema as any).$defs.Address).toBeDefined();

      // Navigate further to home (which references Address via $ref)
      const homeRef = userRef.key("home");
      const homeExport = homeRef.export();

      // The rootSchema should still be preserved at this level
      expect(homeExport.schema).toBeDefined();
      expect((homeExport.schema as any).$defs).toBeDefined();
      expect((homeExport.schema as any).$defs.Address).toBeDefined();

      // Navigate to street (final property)
      const streetRef = homeRef.key("street");
      const streetExport = streetRef.export();

      // The schema at this level should be the string type
      expect(isObject(streetExport.schema)).toBe(true);
      if (isObject(streetExport.schema)) {
        const { $defs: defs, ...rest } = streetExport.schema;
        // Even at the leaf level, defs should be preserved
        expect(defs).toBeDefined();
        expect(rest).toEqual({ type: "string" });
      }
    });

    it("should handle deeply nested $ref chains with key() navigation", () => {
      // Schema with chained $refs
      const schema = {
        $defs: {
          Inner: {
            type: "object",
            properties: {
              value: { type: "number" },
            },
          },
          Middle: {
            type: "object",
            properties: {
              inner: { $ref: "#/$defs/Inner" },
            },
          },
          Outer: {
            type: "object",
            properties: {
              middle: { $ref: "#/$defs/Middle" },
            },
          },
        },
        type: "object",
        properties: {
          outer: { $ref: "#/$defs/Outer" },
        },
      } as const satisfies JSONSchema;

      const ref = cell<{
        outer: {
          middle: {
            inner: {
              value: number;
            };
          };
        };
      }>(undefined, schema);

      // Navigate through the chain
      const valueRef = ref.key("outer").key("middle").key("inner").key("value");
      const exported = valueRef.export();

      // The schema defs should be preserved all the way down
      expect(isObject(exported.schema)).toBe(true);
      if (isObject(exported.schema)) {
        const { $defs: defs, ...rest } = exported.schema;
        expect(defs).toBeDefined();
        expect(defs?.Inner).toBeDefined();
        expect(defs?.Middle).toBeDefined();
        expect(defs?.Outer).toBeDefined();

        // The schema at this level should be the number type
        expect(rest).toEqual({ type: "number" });
      }
    });
  });
});

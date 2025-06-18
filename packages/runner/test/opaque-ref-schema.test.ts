import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import type { Frame, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("OpaqueRef Schema Support", () => {
  let frame: Frame;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["recipe"];
  let cell: ReturnType<typeof createBuilder>["cell"];

  beforeEach(() => {
    // Setup frame for the test
    frame = pushFrame();

    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    const builder = createBuilder(runtime);
    ({ recipe, cell } = builder);
  });

  afterEach(async () => {
    popFrame(frame);
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
      expect(exported.rootSchema).toEqual(schema);
    });

    it("should handle separate root schema", () => {
      // Set a schema with root schema
      const rootSchema = {
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
        rootSchema,
      ).key("details");

      // Export the ref and check both schemas are included
      const exported = ref.export();
      expect(exported.schema).toBeDefined();
      expect(exported.schema).toEqual(rootSchema.properties.details);
      expect(exported.rootSchema).toBeDefined();
      expect(exported.rootSchema).toEqual(rootSchema);
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
      expect(exported.rootSchema).toEqual(schema);
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
      const firstItemRef = itemsRef[0];
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
      expect(exported.rootSchema).toEqual(schema);
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
      expect(exported.rootSchema).toEqual(schema);
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
      expect(exported.rootSchema).toBeUndefined();
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
      expect(alias.rootSchema).toBeDefined();
      expect(alias.rootSchema.type).toBe("object");
    });
  });
});

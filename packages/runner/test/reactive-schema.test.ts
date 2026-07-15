import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Identity } from "@commonfabric/identity";

const signer = await Identity.fromPassphrase("test operator");

type AliasValue = {
  $alias: {
    schema?: JSONSchemaObj;
  };
};
type AliasRecord = Record<string, AliasValue | undefined>;
type UserDetailsInput = {
  user: {
    details: {
      age: number;
    };
  };
};

const aliasValue = (value: unknown): AliasValue => value as AliasValue;
const aliasRecord = (value: unknown): AliasRecord => value as AliasRecord;

function schemaObject(schema: JSONSchema | undefined): JSONSchemaObj {
  expect(schema).toBeDefined();
  expect(typeof schema).toBe("object");
  return schema as JSONSchemaObj;
}

function schemaDefs(
  schema: JSONSchema | undefined,
): Readonly<Record<string, JSONSchema>> {
  const defs = schemaObject(schema).$defs;
  expect(defs).toBeDefined();
  return defs as Readonly<Record<string, JSONSchema>>;
}

describe("Reactive Schema Support", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let cell: ReturnType<typeof createBuilder>["commonfabric"]["cell"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const { commonfabric } = createTrustedBuilder(runtime);
    ({ pattern, cell } = commonfabric);
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

  describe("Schema in Pattern Context", () => {
    it("should initialize opaque refs with schema from argument schema", () => {
      // Create a pattern with schema
      const testPattern = pattern(
        (input) => {
          // Directly return the input
          return input;
        },
        {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
        },
      );

      expect(aliasValue(testPattern.result).$alias).toBeDefined();
      const alias = aliasValue(testPattern.result).$alias;

      // Check that schema was set
      expect(alias.schema).toBeDefined();
      const resultSchema = schemaObject(alias.schema);
      expect(resultSchema.type).toBe("object");
      expect(resultSchema.properties?.name).toEqual({ type: "string" });
      expect(resultSchema.properties?.age).toEqual({ type: "number" });
    });

    it("should track schema through pattern bindings", () => {
      // Create a pattern that uses child properties
      const testPattern = pattern<UserDetailsInput, { age: number }>(
        (input) => {
          const age = input.user.details.age;

          // Export both the original ref and nested property
          return {
            age,
          };
        },
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
      );

      const result = aliasRecord(testPattern.result);
      expect(result.age?.$alias).toBeDefined();
      const alias = aliasValue(result.age).$alias;

      // Check the age property schema
      expect(alias.schema).toBeDefined();
      expect(alias.schema).toEqual({ type: "number" });
    });
  });

  describe("Schema $ref and $defs Resolution", () => {
    it("should preserve only reachable $defs while navigating with key()", () => {
      // Schema with $defs that are needed for nested $ref resolution.
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

      // Person and its Address dependency are both still reachable.
      expect(userExport.schema).toBeDefined();
      const userSchema = schemaObject(userExport.schema);
      expect(userSchema.$defs).toBeDefined();
      expect(userSchema.$defs?.Address).toBeDefined();
      expect(userSchema.$defs?.Person).toBeDefined();

      // Navigate further to home (which references Address via $ref)
      const homeRef = userRef.key("home");
      const homeExport = homeRef.export();

      // Person is no longer reachable, but Address is needed by the cursor.
      expect(homeExport.schema).toBeDefined();
      const homeSchema = schemaObject(homeExport.schema);
      expect(homeSchema.$defs).toBeDefined();
      expect(homeSchema.$defs?.Address).toBeDefined();
      expect(homeSchema.$defs?.Person).toBeUndefined();

      // Navigate to street (final property)
      const streetRef = homeRef.key("street");
      const streetExport = streetRef.export();

      // No definitions are reachable from the concrete leaf.
      expect(streetExport.schema).toEqual({ type: "string" });
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

      // Each step retains the remaining transitive closure and drops definitions
      // that can no longer be reached.
      const outerRef = ref.key("outer");
      expect(Object.keys(schemaDefs(outerRef.export().schema))).toEqual([
        "Inner",
        "Middle",
        "Outer",
      ]);
      const middleRef = outerRef.key("middle");
      expect(Object.keys(schemaDefs(middleRef.export().schema))).toEqual([
        "Inner",
        "Middle",
      ]);
      const innerRef = middleRef.key("inner");
      expect(Object.keys(schemaDefs(innerRef.export().schema))).toEqual([
        "Inner",
      ]);
      const valueRef = innerRef.key("value");
      const exported = valueRef.export();

      // The concrete leaf no longer needs the chain's definitions.
      expect(exported.schema).toEqual({ type: "number" });
    });
  });
});

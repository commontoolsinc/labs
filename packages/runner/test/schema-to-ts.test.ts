import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { handler, lift } from "../src/builder/module.ts";
import { str } from "../src/builder/built-in.ts";
import {
  type Frame,
  type JSONSchema,
  type OpaqueRef,
  Schema,
} from "../src/builder/types.ts";
import { popFrame, pushFrame, recipe } from "../src/builder/recipe.ts";
import { Cell, Runtime } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

// This file primarily tests Schema<> & co from commontools/api/index.ts, which
// gets transitively loaded by the above

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Helper function to check type compatibility at compile time
// This doesn't run any actual tests, but ensures types are correct
function expectType<T, _U extends T>() {}

describe("Schema-to-TS Type Conversion", () => {
  let frame: Frame;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
    frame = pushFrame();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  afterEach(() => {
    popFrame(frame);
  });

  // These tests verify the type conversion at compile time
  // They don't have runtime assertions but help ensure the Schema type works correctly

  it("should convert primitive types", () => {
    type StringSchema = Schema<{ type: "string" }>;
    type NumberSchema = Schema<{ type: "number" }>;
    type BooleanSchema = Schema<{ type: "boolean" }>;
    type NullSchema = Schema<{ type: "null" }>;

    // Verify type compatibility
    expectType<string, StringSchema>();
    expectType<number, NumberSchema>();
    expectType<boolean, BooleanSchema>();
    expectType<null, NullSchema>();
  });

  it("should convert object types", () => {
    type ObjectSchema = Schema<{
      type: "object";
      properties: {
        name: { type: "string" };
        age: { type: "number" };
        isActive: { type: "boolean" };
      };
      required: ["name", "age"];
    }>;

    // Expected type: { name: string; age: number; isActive?: boolean }
    type ExpectedType = {
      name: string;
      age: number;
      isActive?: boolean;
    };

    expectType<ExpectedType, ObjectSchema>();
  });

  it("should convert array types", () => {
    type StringArraySchema = Schema<{
      type: "array";
      items: { type: "string" };
    }>;

    type ObjectArraySchema = Schema<{
      type: "array";
      items: {
        type: "object";
        properties: {
          id: { type: "number" };
          name: { type: "string" };
        };
        required: ["id"];
      };
    }>;

    // Expected types
    type ExpectedStringArray = string[];
    type ExpectedObjectArray = Array<{ id: number; name?: string }>;

    expectType<ExpectedStringArray, StringArraySchema>();
    expectType<ExpectedObjectArray, ObjectArraySchema>();
  });

  /*  it("should handle enum values", () => {
    type ColorSchema = Schema<{
      enum: ["red", "green", "blue"];
    }>;

    type NumberEnumSchema = Schema<{
      enum: [1, 2, 3];
    }>;

    // Expected types
    type ExpectedColorEnum = "red" | "green" | "blue";
    type ExpectedNumberEnum = 1 | 2 | 3;

    expectType<ExpectedColorEnum, ColorSchema>();
    expectType<ExpectedNumberEnum, NumberEnumSchema>();
  });*/

  it("should handle oneOf and anyOf", () => {
    type AnyOfSchema1 = Schema<{
      anyOf: [{ type: "string" }, { type: "number" }];
    }>;

    type AnyOfSchema2 = Schema<{
      anyOf: [
        { type: "object"; properties: { name: { type: "string" } } },
        { type: "object"; properties: { id: { type: "number" } } },
      ];
    }>;

    type AnyOfSchema3 = Schema<{
      anyOf: [
        { type: "object"; properties: { name: { type: "string" } } },
        { type: "object"; properties: { id: { type: "number" } } },
        { type: "string" },
        { type: "number" },
      ];
    }>;

    // Expected types
    type ExpectedAnyOf1 = string | number;
    type ExpectedAnyOf2 = { name?: string } | { id?: number };
    type ExpectedAnyOf3 = { name?: string } | { id?: number } | string | number;

    expectType<ExpectedAnyOf1, AnyOfSchema1>();
    expectType<ExpectedAnyOf2, AnyOfSchema2>();
    expectType<ExpectedAnyOf3, AnyOfSchema3>();
  });

  /*  it("should handle allOf (type intersection)", () => {
    type AllOfSchema = Schema<{
      allOf: [
        { type: "object"; properties: { name: { type: "string" } } },
        { type: "object"; properties: { age: { type: "number" } } },
      ];
    }>;

    // Expected type: { name?: string; age?: number }
    type ExpectedAllOf = { name?: string } & { age?: number };

    expectType<ExpectedAllOf, AllOfSchema>();
  });*/

  it("should handle asCell attribute", () => {
    type CellSchema = Schema<{
      type: "object";
      properties: {
        value: { type: "number" };
      };
      asCell: true;
    }>;

    // Expected type: Cell<{ value?: number }>
    type ExpectedCell = Cell<{ value?: number }>;

    expectType<ExpectedCell, CellSchema>();
  });

  it("should handle nested asCell attributes", () => {
    type NestedCellSchema = Schema<{
      type: "object";
      properties: {
        user: {
          type: "object";
          properties: {
            name: { type: "string" };
            settings: {
              type: "object";
              properties: {
                theme: { type: "string" };
              };
              asCell: true;
            };
          };
        };
      };
    }>;

    // Expected type: { user?: { name?: string; settings: Cell<{ theme?: string }> } }
    type ExpectedNestedCell = {
      user?: {
        name?: string;
        settings?: Cell<{ theme?: string }>;
      };
    };

    expectType<ExpectedNestedCell, NestedCellSchema>();
  });

  it("should handle $ref to root", () => {
    type RecursiveSchema = Schema<{
      type: "object";
      properties: {
        name: { type: "string" };
        children: {
          type: "array";
          items: { $ref: "#" };
        };
      };
    }>;

    // This is a recursive type, so we can't easily define the expected type
    // But we can verify it has the expected structure
    type ExpectedRecursive = {
      name?: string;
      children?: ExpectedRecursive[];
    };

    expectType<ExpectedRecursive, RecursiveSchema>();
  });

  describe("$ref with JSON Pointers and $defs", () => {
    it("should resolve $ref to $defs path", () => {
      type SchemaWithDefs = Schema<{
        $defs: {
          Address: {
            type: "object";
            properties: {
              street: { type: "string" };
              city: { type: "string" };
            };
          };
        };
        type: "object";
        properties: {
          home: { $ref: "#/$defs/Address" };
        };
      }>;

      type Expected = {
        home?: {
          street?: string;
          city?: string;
        };
      };

      expectType<Expected, SchemaWithDefs>();
    });

    it("should handle default at ref site", () => {
      type SchemaWithRefDefault = Schema<{
        $defs: {
          Status: {
            type: "string";
          };
        };
        type: "object";
        properties: {
          currentStatus: {
            $ref: "#/$defs/Status";
            default: "active";
          };
        };
      }>;

      type Expected = {
        currentStatus?: string; // Optional, but has default at runtime
      };

      expectType<Expected, SchemaWithRefDefault>();
    });

    it("should override target default with ref site default", () => {
      type SchemaWithBothDefaults = Schema<{
        $defs: {
          Counter: {
            type: "number";
            default: 0;
          };
        };
        type: "object";
        properties: {
          score: {
            $ref: "#/$defs/Counter";
            default: 100; // Should override target default of 0
          };
        };
      }>;

      type Expected = {
        score?: number; // Optional, default is 100 not 0
      };

      expectType<Expected, SchemaWithBothDefaults>();
    });

    it("should handle nested refs", () => {
      type NestedRefs = Schema<{
        $defs: {
          City: { type: "string" };
          Address: {
            type: "object";
            properties: {
              city: { $ref: "#/$defs/City" };
            };
          };
        };
        type: "object";
        properties: {
          location: { $ref: "#/$defs/Address" };
        };
      }>;

      type Expected = {
        location?: {
          city?: string;
        };
      };

      expectType<Expected, NestedRefs>();
    });

    it("should handle $ref in array items", () => {
      type ArrayOfRefs = Schema<{
        $defs: {
          Tag: { type: "string" };
        };
        type: "object";
        properties: {
          tags: {
            type: "array";
            items: { $ref: "#/$defs/Tag" };
          };
        };
      }>;

      type Expected = {
        tags?: string[];
      };

      expectType<Expected, ArrayOfRefs>();
    });

    it("should handle chained refs", () => {
      type ChainedRefs = Schema<{
        $defs: {
          Level3: { type: "string" };
          Level2: { $ref: "#/$defs/Level3" };
          Level1: { $ref: "#/$defs/Level2" };
        };
        type: "object";
        properties: {
          value: { $ref: "#/$defs/Level1" };
        };
      }>;

      type Expected = {
        value?: string;
      };

      expectType<Expected, ChainedRefs>();
    });

    it("should handle asCell with $ref", () => {
      type CellRef = Schema<{
        $defs: {
          Config: {
            type: "object";
            properties: {
              theme: { type: "string" };
            };
          };
        };
        type: "object";
        properties: {
          settings: {
            $ref: "#/$defs/Config";
            asCell: true;
          };
        };
      }>;

      type Expected = {
        settings?: Cell<{
          theme?: string;
        }>;
      };

      expectType<Expected, CellRef>();
    });

    it("should handle $ref to properties path", () => {
      type RefToProperty = Schema<{
        type: "object";
        properties: {
          name: { type: "string" };
          alias: { $ref: "#/properties/name" };
        };
      }>;

      type Expected = {
        name?: string;
        alias?: string;
      };

      expectType<Expected, RefToProperty>();
    });

    it("should handle multiple refs to same definition", () => {
      type MultipleRefs = Schema<{
        $defs: {
          Email: { type: "string"; format: "email" };
        };
        type: "object";
        properties: {
          primary: { $ref: "#/$defs/Email" };
          secondary: { $ref: "#/$defs/Email" };
        };
      }>;

      type Expected = {
        primary?: string;
        secondary?: string;
      };

      expectType<Expected, MultipleRefs>();
    });

    it("should handle $ref with default in anyOf", () => {
      type RefInAnyOf = Schema<{
        $defs: {
          String: { type: "string" };
          Number: { type: "number" };
        };
        type: "object";
        properties: {
          value: {
            anyOf: [
              { $ref: "#/$defs/String"; default: "text" },
              { $ref: "#/$defs/Number"; default: 42 },
            ];
          };
        };
      }>;

      // Note: anyOf branches with defaults don't make the property required
      // at the type level (TypeScript limitation). The runtime handles this correctly.
      type Expected = {
        value?: string | number;
      };

      expectType<Expected, RefInAnyOf>();
    });

    it("should handle complex nested structure with refs", () => {
      type ComplexNested = Schema<{
        $defs: {
          User: {
            type: "object";
            properties: {
              name: { type: "string" };
              email: { type: "string" };
            };
            required: ["name"];
          };
          Comment: {
            type: "object";
            properties: {
              text: { type: "string" };
              author: { $ref: "#/$defs/User" };
            };
            required: ["text"];
          };
        };
        type: "object";
        properties: {
          post: {
            type: "object";
            properties: {
              title: { type: "string" };
              comments: {
                type: "array";
                items: { $ref: "#/$defs/Comment" };
              };
            };
          };
        };
      }>;

      type Expected = {
        post?: {
          title?: string;
          comments?: Array<{
            text: string;
            author?: {
              name: string;
              email?: string;
            };
          }>;
        };
      };

      expectType<Expected, ComplexNested>();
    });
  });

  it("should handle additionalProperties", () => {
    type StrictObjectSchema = Schema<{
      type: "object";
      properties: {
        id: { type: "number" };
      };
      additionalProperties: false;
    }>;

    type DynamicObjectSchema = Schema<{
      type: "object";
      properties: {
        id: { type: "number" };
      };
      additionalProperties: { type: "string" };
    }>;

    // Expected types
    type ExpectedStrictObject = { id?: number };
    type ExpectedDynamicObject = {
      id?: number;
      [key: string]: string | number | undefined;
    };

    expectType<ExpectedStrictObject, StrictObjectSchema>();
    expectType<ExpectedDynamicObject, DynamicObjectSchema>();
  });

  it("should correctly infer types when using lift with JSON schema", () => {
    // Define input and output schemas
    const inputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["name"],
    } as const satisfies JSONSchema;

    const outputSchema = {
      type: "object",
      properties: {
        processed: { type: "boolean" },
        nameLength: { type: "number" },
        firstTag: { type: "string" },
      },
      //required: ["processed", "nameLength"],
    } as const satisfies JSONSchema;

    // Create a module using lift with JSON schemas
    // This tests type inference - TypeScript should infer the correct input and output types
    const processModule = lift(
      inputSchema,
      outputSchema,
      (input) => {
        // This will only compile if input is correctly typed according to inputSchema
        const nameLength = input.name.length;
        const firstTag = input.tags?.[0] || "";
        const _count = input.count || 0;

        // This will only compile if the return type matches outputSchema
        return {
          processed: true,
          nameLength,
          firstTag,
        };
      },
    );

    // Test with actual data
    processModule({
      name: "Test",
      count: 5,
      tags: ["important", "test"],
    });

    // Check that optional property works
    processModule({
      name: "NoTags",
    });
  });

  it("should correctly infer types when using handler with JSON schema", () => {
    // Define event and state schemas
    const eventSchema = {
      type: "object",
      properties: {
        type: { type: "string" },
        payload: { type: "string" },
      },
      required: ["type"],
    } as const;

    const stateSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
        history: {
          type: "array",
          items: { type: "string" },
        },
        preferences: {
          type: "object",
          properties: {
            notifyOnChange: { type: "boolean" },
          },
          asCell: true,
        },
      },
      required: ["count", "preferences"],
    } as const;

    // Create a handler using JSON schemas
    const eventHandler = handler(
      eventSchema,
      stateSchema,
      (event, state) => {
        // Type checking - this should compile only if types are correctly inferred
        const eventType = event.type;
        const payload = event.payload || "default";

        // Access state properties, including the cell
        const currentCount = state.count;
        const _notifyOnChange = state.preferences.get().notifyOnChange;

        // Add to history if it exists
        const history = state.history || [];
        history.push(payload);

        return {
          type: "EVENT_PROCESSED",
          count: currentCount + 1,
          timestamp: Date.now(),
        };
      },
    );

    // Note that preferences here isn't a cell, since inputs don't have to match
    // the cell/not-cell structure, just the types!
    eventHandler({
      count: 5,
      history: ["previous_event"],
      preferences: { notifyOnChange: true },
    });

    // We're not testing actual handler execution here since that would require a runner setup,
    // but the types should be correctly inferred
  });

  it("should correctly infer types when using recipe with JSON schema", () => {
    // Define input and output schemas
    const inputSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        options: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            tags: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["enabled"],
        },
      },
      required: ["name"],
    } as const;

    const outputSchema = {
      type: "object",
      properties: {
        result: { type: "string" },
        processedCount: { type: "number" },
        status: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            timestamp: { type: "number" },
          },
          required: ["success"],
        },
      },
      required: ["result", "status"],
    } as const;

    // Type aliases to verify the schema inference
    type ExpectedInput = {
      name: string;
      count?: number;
      options?: {
        enabled: boolean;
        tags?: string[];
      };
    };

    type ExpectedOutput = {
      result: string;
      processedCount?: number;
      status: {
        success: boolean;
      };
    };

    // Create a recipe using JSON schemas
    const processRecipe = recipe(
      inputSchema,
      outputSchema,
      (input) => {
        // These lines verify that input has the correct type according to inputSchema
        const name = input.name;
        const count = input.count;
        const enabled = input.options.enabled;

        // Return a value that should match the output schema type
        return {
          result: str`Processed ${name}`,
          processedCount: count,
          status: {
            success: enabled,
          },
        };
      },
    );

    // Verify types statically
    type InferredInput = Parameters<typeof processRecipe>[0];
    type InferredOutput = ReturnType<typeof processRecipe>;

    expectType<ExpectedInput, Schema<typeof inputSchema>>();
    expectType<ExpectedOutput, Schema<typeof outputSchema>>();

    // Verify that the recipe function parameter matches our expected input type
    expectType<ExpectedInput, InferredInput>();

    // The expected output is the output schema wrapped in a single OpaqueRef.
    type DeepOpaqueOutput = OpaqueRef<Schema<typeof outputSchema>>;
    expectType<DeepOpaqueOutput, InferredOutput>();

    // Uncomment for debugging - shows what the actual structure is
    // This should help us see what the real type looks like
    // type Debug = ReturnType<typeof processRecipe>;
  });

  // Runtime tests to verify the Schema type works with actual data
  it("should work with real data at runtime", () => {
    // Define a schema that uses various features
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        settings: {
          type: "object",
          properties: {
            theme: { type: "string" },
            notifications: { type: "boolean" },
          },
          asCell: true,
        },
      },
      required: ["name", "settings"],
    } as const;

    // Create a type from the schema
    type User = Schema<typeof schema>;

    // Create a cell with data matching the schema
    const settingsCell = runtime.getCell(
      space,
      "settings-cell",
      undefined,
      tx,
    );
    settingsCell.set({ theme: "dark", notifications: true });
    tx.commit();
    tx = runtime.edit();

    // This is just to verify the type works at runtime
    // We're not actually testing the Schema type itself, just that it's compatible
    const userData: User = {
      name: "John",
      age: 30,
      tags: ["developer", "typescript"],
      settings: settingsCell.getAsLink() as unknown as Cell<
        Schema<typeof schema.properties.settings>
      >,
    };

    const userCell = runtime.getImmutableCell(
      space,
      userData,
      schema,
      tx,
    );
    const user = userCell.get();

    expect(user.name).toBe("John");
    expect(user.age).toBe(30);
    (expect(user.tags) as any).toEqualIgnoringSymbols([
      "developer",
      "typescript",
    ]);
    (expect(user.settings.get()) as any).toEqualIgnoringSymbols({
      theme: "dark",
      notifications: true,
    });
  });
});

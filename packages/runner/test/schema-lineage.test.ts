import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type Cell,
  createBuilder,
  type JSONSchema,
} from "@commontools/builder";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema Lineage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["recipe"];
  let UI: ReturnType<typeof createBuilder>["UI"];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    const builder = createBuilder(runtime);
    ({ recipe, UI } = builder);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Schema Propagation through Aliases", () => {
    it("should propagate schema from aliases to cells", () => {
      // Create a doc with an alias that has schema information
      const targetDoc = runtime.documentMap.getDoc(
        { count: 42, label: "test" },
        "schema-lineage-target",
        space,
      );

      // Create a schema for our alias
      const schema = {
        type: "object",
        properties: {
          count: { type: "number" },
          label: { type: "string" },
        },
      } as const satisfies JSONSchema;

      // Create a doc with an alias that includes schema information
      const sourceDoc = runtime.documentMap.getDoc(
        {
          $alias: {
            cell: targetDoc,
            path: [],
            schema,
            rootSchema: schema,
          },
        },
        "schema-lineage-source",
        space,
      );

      // Access the doc without providing a schema
      // (Type script type is just to avoid compiler errors)
      const cell: Cell<{ count: number; label: string }> = sourceDoc.asCell();

      // The cell should have picked up the schema from the alias
      expect(cell.schema).toBeDefined();
      expect(cell.schema).toEqual(schema);

      // When we access a nested property, it should have the correct schema
      const countCell = cell.key("count");
      expect(countCell.schema).toBeDefined();
      expect(countCell.schema).toEqual({ type: "number" });
    });

    it("should respect explicitly provided schema over alias schema", () => {
      // Create a doc with an alias that has schema information
      const targetDoc = runtime.documentMap.getDoc(
        { count: 42, label: "test" },
        "schema-lineage-target-explicit",
        space,
      );

      // Create schemas with different types
      const aliasSchema = {
        type: "object",
        properties: {
          count: { type: "number" },
          label: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const explicitSchema = {
        type: "object",
        properties: {
          count: { type: "string" }, // Different type than in aliasSchema
          label: { type: "string" },
        },
      } as const satisfies JSONSchema;

      // Create a doc with an alias that includes schema information
      const sourceDoc = runtime.documentMap.getDoc(
        {
          $alias: {
            cell: targetDoc,
            path: [],
            schema: aliasSchema,
            rootSchema: aliasSchema,
          },
        },
        "schema-lineage-source-explicit",
        space,
      );

      // Access the doc with explicit schema
      const cell = sourceDoc.asCell([], undefined, explicitSchema);

      // The cell should have the explicit schema, not the alias schema
      expect(cell.schema).toBeDefined();
      expect(cell.schema).toEqual(explicitSchema);

      // The nested property should have the schema from explicitSchema
      const countCell = cell.key("count");
      expect(countCell.schema).toBeDefined();
      expect(countCell.schema).toEqual({ type: "string" });
    });
  });

  describe("Schema Propagation from Aliases (without Recipes)", () => {
    it("should track schema through deep aliases", () => {
      // Create a series of nested aliases with schemas
      const valueDoc = runtime.documentMap.getDoc(
        { count: 5, name: "test" },
        "deep-alias-value",
        space,
      );

      // Create a schema for our first level alias
      const numberSchema = { type: "number" };

      // Create a doc with an alias specifically for the count field
      const countDoc = runtime.documentMap.getDoc(
        {
          $alias: {
            cell: valueDoc,
            path: ["count"],
            schema: numberSchema,
            rootSchema: numberSchema,
          },
        },
        "count-alias",
        space,
      );

      // Create a third level of aliasing
      const finalDoc = runtime.documentMap.getDoc(
        {
          $alias: {
            cell: countDoc,
            path: [],
          },
        },
        "final-alias",
        space,
      );

      // Access the doc without providing a schema
      const cell = finalDoc.asCell();

      // The cell should have picked up the schema from the alias chain
      expect(cell.schema).toBeDefined();
      expect(cell.schema).toEqual(numberSchema);
      expect(cell.get()).toBe(5);
    });

    it("should correctly handle aliases with asCell:true in schema", () => {
      // Create a document with nested objects that will be accessed with asCell
      const nestedDoc = runtime.documentMap.getDoc(
        {
          items: [
            { id: 1, name: "Item 1" },
            { id: 2, name: "Item 2" },
          ],
        },
        "nested-doc-with-alias",
        space,
      );

      // Define schemas for the nested objects
      const arraySchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
          },
        },
      } as const satisfies JSONSchema;

      // Create an alias to the items array with schema information
      const itemsDoc = runtime.documentMap.getDoc(
        {
          $alias: {
            cell: nestedDoc,
            path: ["items"],
            schema: arraySchema,
          },
        },
        "items-alias",
        space,
      );

      // Access the items with a schema that specifies array items should be cells
      const itemsCell = itemsDoc.asCell(
        [],
        undefined,
        {
          asCell: true,
        } as const satisfies JSONSchema,
      );

      const value = itemsCell.get();
      expect(isCell(value)).toBe(true);
      expect(value.schema).toEqual(arraySchema);

      const firstItem = value.get()[0];

      // Verify we can access properties of the cell items
      expect(firstItem.id).toBe(1);
      expect(firstItem.name).toBe("Item 1");
    });
  });
});

describe("Schema propagation end-to-end example", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["recipe"];
  let UI: ReturnType<typeof createBuilder>["UI"];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    const builder = createBuilder(runtime);
    ({ recipe, UI } = builder);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should propagate schema through a recipe", () => {
    // Create a recipe with schema
    const testRecipe = recipe({
      type: "object",
      properties: {
        details: {
          type: "object",
          properties: {
            name: {
              type: "string",
            },
          },
          additionalProperties: false,
        },
      },
      // TODO(seefeld): Fix type inference and replace any
    }, (input: any) => ({
      [UI]: {
        type: "element",
        name: "input",
        props: {
          value: input.details,
        },
      },
    }));

    const result = runtime.documentMap.getDoc(
      undefined,
      "should propagate schema through a recipe",
      space,
    );
    runtime.run(
      testRecipe,
      { details: { name: "hello", age: 14 } },
      result,
    );

    const c = result.asCell(
      [UI],
      undefined,
      {
        type: "object",
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          props: {
            type: "object",
            additionalProperties: { asCell: true },
          },
        },
      } as const satisfies JSONSchema,
    );

    expect(isCell(c.get().props.value)).toBe(true);
    expect(c.get().props.value.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    });
    expect(c.get().props.value.get()).toEqual({ name: "hello" });
  });
});

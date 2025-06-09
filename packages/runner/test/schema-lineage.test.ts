import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBuilder } from "@commontools/builder";
import { type JSONSchema, UI } from "@commontools/builder/interface";
import { type Cell, isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";

describe("Schema Lineage", () => {
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["recipe"];

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
    const builder = createBuilder(runtime);
    ({ recipe } = builder);
  });

  afterEach(async () => {
    await runtime?.dispose();
  });

  describe("Schema Propagation through Aliases", () => {
    it("should propagate schema from aliases to cells", () => {
      // Create a doc with an alias that has schema information
      const targetDoc = runtime.documentMap.getDoc(
        { count: 42, label: "test" },
        "schema-lineage-target",
        "test",
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
        "test",
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
        "test",
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
        "test",
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
        "test",
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
        "test",
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
        "test",
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
        "test",
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
        "test",
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
  let runtime: Runtime;
  let recipe: ReturnType<typeof createBuilder>["recipe"];

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
    const builder = createBuilder(runtime);
    ({ recipe } = builder);
  });

  afterEach(async () => {
    await runtime?.dispose();
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
      "test",
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

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Cell, isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema, recipe, UI } from "@commontools/builder";

describe("Schema Lineage", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
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
  });
});

describe("Schema propagation end-to-end example", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      storageUrl: "volatile://",
    });
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
    runtime.runner.run(
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

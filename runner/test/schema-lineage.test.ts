import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getDoc } from "../src/doc.ts";
import { type Cell } from "../src/cell.ts";
import { type JSONSchema } from "@commontools/builder";

describe("Schema Lineage", () => {
  describe("Schema Propagation through Aliases", () => {
    it("should propagate schema from aliases to cells", () => {
      // Create a doc with an alias that has schema information
      const targetDoc = getDoc(
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
      const sourceDoc = getDoc(
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
      const targetDoc = getDoc(
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
      const sourceDoc = getDoc(
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
      const valueDoc = getDoc(
        { count: 5, name: "test" },
        "deep-alias-value",
        "test",
      );

      // Create a schema for our first level alias
      const numberSchema = { type: "number" };

      // Create a doc with an alias specifically for the count field
      const countDoc = getDoc(
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
      const finalDoc = getDoc(
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
  });
});

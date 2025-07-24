import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Cell, type JSONSchema } from "../src/builder/types.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import "./utils/matchers.ts"; // Import custom matchers

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema Lineage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let UI: ReturnType<typeof createBuilder>["commontools"]["UI"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
    const { commontools } = createBuilder(runtime);
    ({ recipe, UI } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Schema Propagation through Aliases", () => {
    it("should propagate schema from aliases to cells", () => {
      // Create a cell with data that will be referenced by an alias
      const targetCell = runtime.getCell<{ count: number; label: string }>(
        space,
        "schema-lineage-target",
        undefined,
        tx,
      );
      targetCell.set({ count: 42, label: "test" });

      // Create a schema for our alias
      const schema = {
        type: "object",
        properties: {
          count: { type: "number" },
          label: { type: "string" },
        },
      } as const satisfies JSONSchema;

      // Create a cell with an alias that includes schema information
      const sourceCell = runtime.getCell<any>(
        space,
        "schema-lineage-source",
        undefined,
        tx,
      );
      sourceCell.setRaw(
        targetCell.asSchema(schema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );

      // Access the cell without providing a schema (Type script type is just to
      // avoid compiler errors, we're testing the underlying cell loading)
      const cell = runtime.getCell<{ count: number; label: string }>(
        space,
        "schema-lineage-source", // same id as above
        undefined,
        tx,
      );

      // The cell should have picked up the schema from the alias
      expect(cell.schema).toBeDefined();
      expect(cell.schema).toEqual(schema);

      // When we access a nested property, it should have the correct schema
      const countCell = cell.key("count");
      expect(countCell.schema).toBeDefined();
      expect(countCell.schema).toEqual({ type: "number" });
    });

    it("should respect explicitly provided schema over alias schema", () => {
      // Create a cell with data that will be referenced by an alias
      const targetCell = runtime.getCell<{ count: number; label: string }>(
        space,
        "schema-lineage-target-explicit",
        undefined,
        tx,
      );
      targetCell.set({ count: 42, label: "test" });

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

      // Create a cell with an alias that includes schema information
      const sourceCell = runtime.getCell<any>(
        space,
        "schema-lineage-source-explicit",
        undefined,
        tx,
      );
      sourceCell.setRaw(
        targetCell.asSchema(aliasSchema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );

      // Access the cell with explicit schema
      const cell = sourceCell.asSchema(explicitSchema);

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
      const valueCell = runtime.getCell<{ count: number; name: string }>(
        space,
        "deep-alias-value",
        undefined,
        tx,
      );
      valueCell.set({ count: 5, name: "test" });

      // Create a schema for our first level alias
      const numberSchema = { type: "number" } as const satisfies JSONSchema;

      // Create a cell with an alias specifically for the count field
      const countCell = runtime.getCell<any>(
        space,
        "count-alias",
        undefined,
        tx,
      );
      countCell.setRaw(
        valueCell.key("count").asSchema(numberSchema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );

      // Create a third level of aliasing
      const finalCell = runtime.getCell<any>(
        space,
        "final-alias",
        undefined,
        tx,
      );
      finalCell.setRaw(countCell.getAsWriteRedirectLink({
        includeSchema: true,
      }));

      // Access the cell without providing a schema (Type script type is just to
      // avoid compiler errors, we're testing the underlying cell loading)
      const cell = runtime.getCell<number>(
        space,
        "final-alias", // same id as above
        undefined,
        tx,
      );

      // The cell should have picked up the schema from the alias chain
      expect(cell.schema).toBeDefined();
      expect(cell.schema).toEqual(numberSchema);
      expect(cell.get()).toBe(5);
    });

    it("should correctly handle aliases with asCell:true in schema", () => {
      // Create a cell with nested objects that will be accessed with asCell
      const nestedCell = runtime.getCell<{
        items: Array<{ id: number; name: string }>;
      }>(
        space,
        "nested-doc-with-alias",
        undefined,
        tx,
      );
      nestedCell.set({
        items: [
          { id: 1, name: "Item 1" },
          { id: 2, name: "Item 2" },
        ],
      });

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
      const itemsCell = runtime.getCell<any>(
        space,
        "items-alias",
        undefined,
        tx,
      );
      itemsCell.setRaw(
        nestedCell.key("items").asSchema(arraySchema).getAsWriteRedirectLink({
          includeSchema: true,
        }),
      );

      // Access the items with a schema that specifies array items should be cells
      const itemsCellWithSchema = itemsCell.asSchema(
        {
          asCell: true,
        } as const satisfies JSONSchema,
      );

      const value = itemsCellWithSchema.get() as any;
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
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let UI: ReturnType<typeof createBuilder>["commontools"]["UI"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
    const { commontools } = createBuilder(runtime);
    ({ recipe, UI } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
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

    const resultCell = runtime.getCell<any>(
      space,
      "should propagate schema through a recipe",
      undefined,
      tx,
    );
    runtime.run(
      tx,
      testRecipe,
      { details: { name: "hello", age: 14 } },
      resultCell,
    );

    const c = resultCell.key(UI).asSchema(
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

    const cValue = c.get() as any;
    expect(isCell(cValue.props.value)).toBe(true);
    expect(cValue.props.value.schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    });
    expect(cValue.props.value.get()).toEqualIgnoringSymbols({ name: "hello" });
  });
});

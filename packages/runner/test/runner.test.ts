import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NAME, type Recipe } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { extractDefaultValues, mergeObjects } from "../src/runner.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

// Memory implementation is too deep for the default stack trace limit
(Error as any).stackTraceLimit = 1000;

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("runRecipe", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.storage.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should work with passthrough", async () => {
    const recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
        description: "passthrough",
      },
      resultSchema: {},
      result: { output: { $alias: { path: ["internal", "output"] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { path: ["argument", "input"] } } },
          outputs: { value: { $alias: { path: ["internal", "output"] } } },
        },
      ],
    } as Recipe;

    const resultCell = runtime.getCell(
      space,
      "should work with passthrough",
    );
    const result = await runtime.runSynced(resultCell, recipe, { input: 1 });
    await runtime.idle();

    expect(result.getSourceCell()?.getAsQueryResult()).toMatchObject({
      argument: { input: 1 },
      internal: { output: 1 },
    });
    expect(result.getSourceCell()?.getRaw().internal.output).toBe(1);
    expect(result.getRaw()).toEqual({
      output: {
        $alias: {
          path: ["internal", "output"],
          cell: JSON.parse(JSON.stringify(result.getSourceCell()?.getDoc())),
        },
      },
    });
    expect(result.getAsQueryResult()).toEqual({ output: 1 });
  });

  it("should work with nested recipes", async () => {
    const innerRecipe = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
      },
      resultSchema: {},
      result: { $alias: { cell: 1, path: ["internal", "output"] } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: {
            value: { $alias: { cell: 1, path: ["argument", "input"] } },
          },
          outputs: {
            value: { $alias: { cell: 1, path: ["internal", "output"] } },
          },
        },
      ],
    } as Recipe;

    const outerRecipe = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
          result: { type: "number" },
        },
      },
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "output"] } } },
      nodes: [
        {
          module: { type: "recipe", implementation: innerRecipe },
          inputs: { input: { $alias: { path: ["argument", "value"] } } },
          outputs: { $alias: { path: ["internal", "output"] } },
        },
      ],
    } as Recipe;

    const resultCell = runtime.getCell(
      space,
      "should work with nested recipes",
    );
    const result = await runtime.runSynced(resultCell, outerRecipe, {
      value: 5,
    });
    await runtime.idle();

    expect(result.getAsQueryResult()).toEqual({ result: 5 });
  });

  it("should run a simple module", async () => {
    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: { $alias: { path: ["internal", "result"] } },
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should run a simple module",
    );
    const result = await runtime.runSynced(resultCell, mockRecipe, {
      value: 1,
    });
    await runtime.idle();
    expect(result.getAsQueryResult()).toEqual({ result: 2 });
  });

  it("should run a simple module with no outputs", async () => {
    let ran = false;

    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { path: ["argument", "value"] } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should run a simple module with no outputs",
    );
    const result = await runtime.runSynced(resultCell, mockRecipe, {
      value: 1,
    });
    await runtime.idle();
    expect(result.getAsQueryResult()).toEqual({ result: undefined });
    expect(ran).toBe(true);
  });

  it("should handle incorrect inputs gracefully", async () => {
    let ran = false;

    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { path: ["argument", "other"] } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should handle incorrect inputs gracefully",
    );
    const result = await runtime.runSynced(resultCell, mockRecipe, {
      value: 1,
    });
    await runtime.idle();
    expect(result.getAsQueryResult()).toEqual({ result: undefined });
    expect(ran).toBe(true);
  });

  it("should handle nested recipes", async () => {
    const nestedRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { $alias: { cell: 1, path: ["internal", "result"] } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: 1, path: ["argument", "input"] } },
          outputs: { $alias: { cell: 1, path: ["internal", "result"] } },
        },
      ],
    };

    const mockRecipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: { type: "recipe", implementation: nestedRecipe },
          inputs: { input: { $alias: { path: ["argument", "value"] } } },
          outputs: { $alias: { path: ["internal", "result"] } },
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should handle nested recipes",
    );
    const result = await runtime.runSynced(resultCell, mockRecipe, {
      value: 1,
    });
    await runtime.idle();
    expect(result.getAsQueryResult()).toEqual({ result: 2 });
  });

  it("should allow passing a cell as a binding", async () => {
    const recipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { path: ["argument", "output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["argument", "input"] } },
          outputs: { $alias: { path: ["argument", "output"] } },
        },
      ],
    };

    const tx1 = runtime.edit();
    const inputCell = runtime.getCell<{ input: number; output: number }>(
      space,
      "should allow passing a cell as a binding: input cell",
      undefined,
      tx1,
    );
    inputCell.set({ input: 10, output: 0 });
    await tx1.commit();

    const resultCell = runtime.getCell(
      space,
      "should allow passing a cell as a binding",
    );

    const result = await runtime.runSynced(resultCell, recipe, inputCell);

    await runtime.idle();

    expect(inputCell.get()).toMatchObject({ input: 10, output: 20 });
    expect(result.get()).toEqual({ output: 20 });

    // The result should alias the original cell. Let's verify by stopping the
    // recipe and sending a new value to the input cell.
    runtime.runner.stop(result);

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 10, output: 40 });
    await tx2.commit();

    expect(result.get()).toEqual({ output: 40 });

    await runtime.idle();
  });

  it("should allow stopping a recipe", async () => {
    const recipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { path: ["argument", "output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { path: ["argument", "input"] } },
          outputs: { $alias: { path: ["argument", "output"] } },
        },
      ],
    };

    const tx = runtime.edit();
    const inputCell = runtime.getCell<{ input: number; output: number }>(
      space,
      "should allow stopping a recipe: input cell",
      undefined,
      tx,
    );
    inputCell.set({ input: 10, output: 0 });
    const resultCell = runtime.getCell(
      space,
      "should allow stopping a recipe",
      undefined,
      tx,
    );

    // Commit the initial values before running the recipe
    await tx.commit();

    const result = await runtime.runSynced(resultCell, recipe, inputCell);

    await runtime.idle();
    expect(inputCell.get()).toMatchObject({ input: 10, output: 20 });

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 20, output: 20 });
    await tx2.commit();
    await runtime.idle();

    expect(inputCell.get()).toMatchObject({ input: 20, output: 40 });

    // Stop the recipe
    runtime.runner.stop(result);

    const tx3 = runtime.edit();
    inputCell.withTx(tx3).send({ input: 40, output: 40 });
    await tx3.commit();
    await runtime.idle();

    expect(inputCell.get()).toMatchObject({ input: 40, output: 40 });

    // Restart the recipe
    await runtime.runSynced(result, recipe, undefined);

    await runtime.idle();
    expect(inputCell.get()).toMatchObject({ input: 40, output: 80 });
  });

  it("should apply default values from argument schema", async () => {
    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number", default: 42 },
          multiplier: { type: "number", default: 2 },
        },
        required: ["input"],
      },
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number; multiplier: number }) =>
              args.input * args.multiplier,
          },
          inputs: { $alias: { path: ["argument"] } },
          outputs: { $alias: { path: ["internal", "result"] } },
        },
      ],
    };

    // Test with partial arguments (should use default for multiplier)
    const resultWithPartialCell = runtime.getCell(
      space,
      "default values test - partial",
    );

    const resultWithPartial = await runtime.runSynced(
      resultWithPartialCell,
      recipe,
      { input: 10 },
    );
    await runtime.idle();
    expect(resultWithPartial.getAsQueryResult()).toEqual({ result: 20 });

    // Test with no arguments (should use default for input)
    const resultWithDefaultsCell = runtime.getCell(
      space,
      "default values test - all defaults",
    );

    const resultWithDefaults = await runtime.runSynced(
      resultWithDefaultsCell,
      recipe,
      {},
    );
    await runtime.idle();
    expect(resultWithDefaults.getAsQueryResult()).toEqual({ result: 84 }); // 42 * 2
  });

  it("should handle complex nested schema types", async () => {
    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "number" },
              },
              operation: { type: "string", enum: ["sum", "avg", "max"] },
            },
            required: ["values", "operation"],
          },
        },
        required: ["config"],
      },
      resultSchema: {},
      result: { result: { $alias: { path: ["internal", "result"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (
              args: { config: { values: number[]; operation: string } },
            ) => {
              const values = args.config.values;
              switch (args.config.operation) {
                case "sum":
                  return values.reduce((a, b) => a + b, 0);
                case "avg":
                  return values.length
                    ? values.reduce((a, b) => a + b, 0) / values.length
                    : 0;
                case "max":
                  return Math.max(...values);
                default:
                  return 0;
              }
            },
          },
          inputs: { $alias: { path: ["argument"] } },
          outputs: { $alias: { path: ["internal", "result"] } },
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "complex schema test",
    );
    const result = await runtime.runSynced(resultCell, recipe, {
      config: { values: [10, 20, 30, 40], operation: "avg" },
    });
    await runtime.idle();
    expect(result.getAsQueryResult()).toEqual({ result: 25 });

    // Test with a different operation
    const result2 = await runtime.runSynced(result, recipe, {
      config: { values: [10, 20, 30, 40], operation: "max" },
    });
    await runtime.idle();
    expect(result2.getAsQueryResult()).toEqual({ result: 40 });
  });

  it("should merge arguments with defaults from schema", async () => {
    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          options: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true },
              value: { type: "number", default: 100 },
              name: { type: "string", default: "default" },
            },
          },
          input: { type: "number", default: 1 },
        },
      },
      resultSchema: {},
      result: {
        result: { $alias: { path: ["internal", "result"] } },
        options: { $alias: { path: ["argument", "options"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number; options: any }) => {
              return args.options.enabled ? args.input * args.options.value : 0;
            },
          },
          inputs: { $alias: { path: ["argument"] } },
          outputs: { $alias: { path: ["internal", "result"] } },
        },
      ],
    };

    // Provide partial options - should merge with defaults
    const resultCell = runtime.getCell(
      space,
      "merge defaults test",
    );
    const result = await runtime.runSynced(resultCell, recipe, {
      options: { value: 10 },
      input: 5,
    });
    await runtime.idle();

    expect(result.getAsQueryResult().options).toEqual({
      enabled: true,
      value: 10,
      name: "default",
    });
    expect(result.getAsQueryResult().result).toEqual(50); // 5 * 10
  });

  it("should preserve NAME between runs", async () => {
    const recipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      initial: { internal: { counter: 0 } },
      result: {
        [NAME]: "counter",
        counter: { $alias: { path: ["internal", "counter"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (input: any) => {
              return input.value;
            },
          },
          inputs: { $alias: { path: ["argument"] } },
          outputs: { $alias: { path: ["internal", "counter"] } },
        },
      ],
    };

    const resultCell = runtime.getCell<any>(
      space,
      "state preservation test",
    );

    // First run
    await runtime.runSynced(resultCell, recipe, { value: 1 });
    await runtime.idle();
    expect(resultCell.get()?.[NAME]).toEqual("counter");
    expect(resultCell.getAsQueryResult()?.counter).toEqual(1);

    // Now change the name
    resultCell.getAsQueryResult()[NAME] = "my counter";

    // Second run with same recipe but different argument
    await runtime.runSynced(resultCell, recipe, { value: 2 });
    await runtime.idle();
    expect(resultCell.get()?.[NAME]).toEqual("my counter");
    expect(resultCell.getAsQueryResult()?.counter).toEqual(2);
  });

  it("should create separate copies of initial values for each recipe instance", async () => {
    const recipe: Recipe = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
        },
      },
      initial: {
        internal: {
          counter: 10,
          nested: { value: "initial" },
        },
      },
      resultSchema: {},
      result: {
        counter: { $alias: { path: ["internal", "counter"] } },
        nested: { $alias: { path: ["internal", "nested"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number }) => {
              return {
                counter: args.input,
              };
            },
          },
          inputs: { $alias: { path: ["argument", "input"] } },
          outputs: { $alias: { path: ["internal", "counter"] } },
        },
      ],
    };

    // Create first instance
    const result1Cell = runtime.getCell(
      space,
      "should create separate copies of initial values 1",
    );
    const result1 = await runtime.runSynced(result1Cell, recipe, {
      input: 5,
    });
    await runtime.idle();

    // Create second instance
    const result2Cell = runtime.getCell(
      space,
      "should create separate copies of initial values 2",
    );
    const result2 = await runtime.runSynced(result2Cell, recipe, {
      input: 10,
    });
    await runtime.idle();

    // Get the internal state objects
    const internal1 = result1.getSourceCell()?.getRaw().internal;
    const internal2 = result2.getSourceCell()?.getRaw().internal;

    // Verify they are different objects
    expect(internal1).not.toBe(internal2);
    expect(internal1.nested).not.toBe(internal2.nested);

    // Modify nested object in first instance
    internal1.nested.value = "modified";

    // Verify second instance is unaffected
    expect(internal2.nested.value).toBe("initial");
    expect(result2.getAsQueryResult().nested.value).toBe("initial");
  });
});

describe("runner utils", () => {
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
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("extractDefaultValues", () => {
    it("should extract default values from a schema", () => {
      const schema = {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, default: "John" },
          age: { type: "number" as const, default: 30 },
          address: {
            type: "object" as const,
            properties: {
              street: { type: "string" as const, default: "Main St" },
              city: { type: "string" as const, default: "New York" },
            },
          },
        },
      };

      const result = extractDefaultValues(schema);
      expect(result).toEqual({
        name: "John",
        age: 30,
        address: {
          street: "Main St",
          city: "New York",
        },
      });
    });
  });

  describe("mergeObjects", () => {
    it("should merge multiple objects", () => {
      const obj1 = { a: 1, b: { x: 10 } };
      const obj2 = { b: { y: 20 }, c: 3 };
      const obj3 = { a: 4, d: 5 };

      const result = mergeObjects<unknown>(obj1, obj2, obj3);
      expect(result).toEqual({
        a: 1,
        b: { x: 10, y: 20 },
        c: 3,
        d: 5,
      });
    });

    it("should handle undefined values", () => {
      const obj1 = { a: 1 };
      const obj2 = undefined;
      const obj3 = { b: 2 };

      const result = mergeObjects<unknown>(obj1, obj2, obj3);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should give precedence to earlier objects in the case of a conflict", () => {
      const obj1 = { a: 1 };
      const obj2 = { a: 2, b: { c: 3 } };
      const obj3 = { a: 3, b: { c: 4 } };

      const result = mergeObjects(obj1, obj2, obj3);
      expect(result).toEqual({ a: 1, b: { c: 3 } });
    });

    it("should treat cell aliases and references as values", () => {
      const testCell = runtime.getCell<{ a: any }>(
        space,
        "should treat cell aliases and references as values 1",
        undefined,
        tx,
      );
      const obj1 = { a: { $alias: { path: [] } } };
      const obj2 = { a: 2, b: { c: testCell.getAsLink() } };
      const obj3 = {
        a: testCell.key("a").getAsWriteRedirectLink(),
        b: { c: 4 },
      };

      const result = mergeObjects<unknown>(obj1, obj2, obj3);
      expect(result).toEqual({
        a: { $alias: { path: [] } },
        b: { c: testCell.getAsLink() },
      });
    });
  });
});

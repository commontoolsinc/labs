import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Recipe } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

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

    const result = runtime.run(
      recipe,
      { input: 1 },
      runtime.documentMap.getDoc(
        undefined,
        "should work with passthrough",
        space,
      ),
    );
    await runtime.idle();

    expect(result.sourceCell?.getAsQueryResult()).toMatchObject({
      argument: { input: 1 },
      internal: { output: 1 },
    });
    expect(result.sourceCell?.get().internal.output).toBe(1);
    expect(result.get()).toEqual({
      output: {
        $alias: { path: ["internal", "output"], cell: result.sourceCell },
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

    const result = runtime.run(
      outerRecipe,
      { value: 5 },
      runtime.documentMap.getDoc(
        undefined,
        "should work with nested recipes",
        space,
      ),
    );
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

    const result = runtime.run(
      mockRecipe,
      { value: 1 },
      runtime.documentMap.getDoc(
        undefined,
        "should run a simple module",
        space,
      ),
    );
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

    const result = runtime.run(
      mockRecipe,
      { value: 1 },
      runtime.documentMap.getDoc(
        undefined,
        "should run a simple module with no outputs",
        space,
      ),
    );
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

    const result = runtime.run(
      mockRecipe,
      { value: 1 },
      runtime.documentMap.getDoc(
        undefined,
        "should handle incorrect inputs gracefully",
        space,
      ),
    );
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

    const result = runtime.run(
      mockRecipe,
      { value: 1 },
      runtime.documentMap.getDoc(
        undefined,
        "should handle nested recipes",
        space,
      ),
    );
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

    const inputCell = runtime.documentMap.getDoc(
      { input: 10, output: 0 },
      "should allow passing a cell as a binding: input cell",
      space,
    );
    const result = runtime.run(
      recipe,
      inputCell,
      runtime.documentMap.getDoc(
        undefined,
        "should allow passing a cell as a binding",
        space,
      ),
    );

    await runtime.idle();

    expect(inputCell.get()).toMatchObject({ input: 10, output: 20 });
    expect(result.getAsQueryResult()).toEqual({ output: 20 });

    // The result should alias the original cell. Let's verify by stopping the
    // recipe and sending a new value to the input cell.
    runtime.runner.stop(result);
    inputCell.send({ input: 10, output: 40 });
    await runtime.idle();
    expect(result.getAsQueryResult()).toEqual({ output: 40 });
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

    const inputCell = runtime.documentMap.getDoc(
      { input: 10, output: 0 },
      "should allow stopping a recipe: input cell",
      space,
    );
    const result = runtime.run(
      recipe,
      inputCell,
      runtime.documentMap.getDoc(
        undefined,
        "should allow stopping a recipe",
        space,
      ),
    );

    await runtime.idle();
    expect(inputCell.get()).toMatchObject({ input: 10, output: 20 });

    inputCell.send({ input: 20, output: 20 });
    await runtime.idle();
    expect(inputCell.get()).toMatchObject({ input: 20, output: 40 });

    // Stop the recipe
    runtime.runner.stop(result);

    inputCell.send({ input: 40, output: 40 });
    await runtime.idle();
    expect(inputCell.get()).toMatchObject({ input: 40, output: 40 });

    // Restart the recipe
    runtime.run(recipe, undefined, result);

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
    const resultWithPartial = runtime.run(
      recipe,
      { input: 10 },
      runtime.documentMap.getDoc(
        undefined,
        "default values test - partial",
        space,
      ),
    );
    await runtime.idle();
    expect(resultWithPartial.getAsQueryResult()).toEqual({ result: 20 });

    // Test with no arguments (should use default for input)
    const resultWithDefaults = runtime.run(
      recipe,
      {},
      runtime.documentMap.getDoc(
        undefined,
        "default values test - all defaults",
        space,
      ),
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

    const result = runtime.run(
      recipe,
      { config: { values: [10, 20, 30, 40], operation: "avg" } },
      runtime.documentMap.getDoc(undefined, "complex schema test", space),
    );
    await runtime.idle();
    expect(result.getAsQueryResult()).toEqual({ result: 25 });

    // Test with a different operation
    const result2 = runtime.run(
      recipe,
      { config: { values: [10, 20, 30, 40], operation: "max" } },
      result,
    );
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
    const result = runtime.run(
      recipe,
      { options: { value: 10 }, input: 5 },
      runtime.documentMap.getDoc(
        undefined,
        "merge defaults test",
        space,
      ),
    );
    await runtime.idle();

    expect(result.getAsQueryResult().options).toEqual({
      enabled: true,
      value: 10,
      name: "default",
    });
    expect(result.getAsQueryResult().result).toEqual(50); // 5 * 10
  });

  it("should preserve result state between runs when recipe doesn't change", async () => {
    const recipe: Recipe = {
      argumentSchema: {},
      resultSchema: {},
      initial: { internal: { counter: 0 } },
      result: {
        name: "counter",
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

    const resultCell = runtime.documentMap.getDoc<any>(
      undefined,
      "state preservation test",
      space,
    );

    // First run
    runtime.run(recipe, { value: 1 }, resultCell);
    await runtime.idle();
    expect(resultCell.get()?.name).toEqual("counter");
    expect(resultCell.getAsQueryResult()?.counter).toEqual(1);

    // Now change the name
    resultCell.setAtPath(["name"], "my counter");

    // Second run with same recipe but different argument
    runtime.run(recipe, { value: 2 }, resultCell);
    await runtime.idle();
    expect(resultCell.get()?.name).toEqual("my counter");
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
    const result1 = runtime.run(
      recipe,
      { input: 5 },
      runtime.documentMap.getDoc(
        undefined,
        "should create separate copies of initial values 1",
        space,
      ),
    );
    await runtime.idle();

    // Create second instance
    const result2 = runtime.run(
      recipe,
      { input: 10 },
      runtime.documentMap.getDoc(
        undefined,
        "should create separate copies of initial values 2",
        space,
      ),
    );
    await runtime.idle();

    // Get the internal state objects
    const internal1 = result1.sourceCell?.get().internal;
    const internal2 = result2.sourceCell?.get().internal;

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

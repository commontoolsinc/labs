import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Module, NAME, type Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { extractDefaultValues, mergeObjects } from "../src/runner.ts";
import {
  type ICommitNotification,
  type IExtendedStorageTransaction,
  type IStorageSubscription,
  type MediaType,
  type URI,
} from "../src/storage/interface.ts";
import { trustExecutable } from "./support/trusted-builder.ts";
import {
  areNormalizedLinksSame,
  getDerivedInternalCell,
  getMetaLink,
  isWriteRedirectLink,
  parseLink,
} from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

function runTrusted(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  executable: Pattern | Module,
  argument: unknown,
  resultCell: unknown,
) {
  return runtime.run(
    tx,
    trustExecutable(runtime, executable),
    argument as never,
    resultCell as never,
  );
}

function setupTrusted(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  executable: Pattern | Module | undefined,
  argument: unknown,
  resultCell: unknown,
) {
  return runtime.setup(
    tx,
    trustExecutable(runtime, executable),
    argument as never,
    resultCell as never,
  );
}

describe("runPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should work with passthrough", async () => {
    const pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
        description: "passthrough",
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "should work with passthrough",
    );
    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      { input: 1 },
      resultCell,
    );

    await resultCell.pull();
    const argumentCellValue = resultCell.getArgumentCell()?.get();
    expect(argumentCellValue).toEqual({ input: 1 });
    const outputCell = getDerivedInternalCell(resultCell, {
      partialCause: "output",
    });
    const outputLink = outputCell.getAsNormalizedFullLink();
    // getDerivedInternalCell doesn't generate a redirect link,
    // but that's what we want to match, so add that property.
    expect(
      areNormalizedLinksSame(
        parseLink((result.getRaw() as { output: unknown }).output, result)!,
        { ...outputLink, overwrite: "redirect" },
      ),
    ).toBe(true);
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ output: 1 });
  });

  it("writes internal aliases through derived internal cell manifest links", async () => {
    const pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
        },
      },
      resultSchema: {},
      derivedInternalCells: [{
        partialCause: "output",
        schema: { type: "number", default: 0 },
        scope: "space",
      }],
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "derived internal passthrough",
    );
    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      { input: 5 },
      resultCell,
    );

    await resultCell.pull();
    const internalManifest = resultCell.getMetaRaw("internal");
    expect(internalManifest).toBeDefined();
    const rawLink = Array.isArray(internalManifest)
      ? internalManifest.find((entry) => entry?.partialCause === "output").link
      : undefined;
    expect(isWriteRedirectLink(rawLink)).toBe(true);

    const derivedLink = parseLink(rawLink, resultCell);
    expect(derivedLink).toBeDefined();
    expect(derivedLink!.id).not.toBe(resultCell.getAsNormalizedFullLink().id);
    expect(derivedLink!.path).toEqual([]);
    expect(derivedLink!.schema).toEqual({ type: "number", default: 0 });

    const derivedCell = runtime.getCellFromLink(derivedLink!);
    expect(await derivedCell.get()).toBe(5);
    expect(await result.pull()).toEqual({ output: 5 });
  });

  it("sets scoped write-redirect metadata links for argument and internal cells", async () => {
    const argumentSchema = {
      type: "object",
      properties: {
        input: { type: "number" },
      },
      required: ["input"],
    } as const;
    const resultSchema = {
      type: "object",
      scope: "user",
      properties: {
        output: { type: "number" },
      },
      required: ["output"],
    } as const;
    const pattern = {
      argumentSchema,
      resultSchema,
      derivedInternalCells: [
        {
          partialCause: "output",
          schema: { type: "number" },
        },
      ],
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "sets scoped write-redirect metadata links",
      resultSchema,
      undefined,
      "user",
    );
    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      { input: 7 },
      resultCell,
    );

    await resultCell.pull();

    const resultCellLink = resultCell.getAsNormalizedFullLink();
    const argumentLink = getMetaLink(resultCell, "argument");

    expect(resultCellLink.scope).toBe("user");
    expect(resultCell.getMetaRaw("schema")).toEqual(resultSchema);
    expect(argumentLink).toBeDefined();
    expect(argumentLink!.path).toEqual([]);
    expect(argumentLink!.space).toBe(space);
    expect(argumentLink!.scope).toBe("user");
    expect(argumentLink!.schema).toEqual(argumentSchema);
    expect(argumentLink!.overwrite).toBe("redirect");

    const argumentCell = runtime.getCellFromLink(argumentLink!);
    expect(argumentCell.get()).toEqual({ input: 7 });
    const outputCell = getDerivedInternalCell(resultCell, {
      partialCause: "output",
      schema: pattern.derivedInternalCells![0].schema,
    });
    const outputLink = outputCell.getAsNormalizedFullLink();
    expect(outputLink.path).toEqual([]);
    expect(outputLink.space).toBe(space);
    expect(outputLink.scope).toBe("user");
    expect(outputLink.schema).toEqual({ type: "number" });
    expect(getMetaLink(argumentCell, "result")).toEqual({
      ...resultCellLink,
      schema: resultSchema,
      overwrite: "redirect",
    });
    // getDerivedInternalCell doesn't generate a redirect link,
    // but that's what we want to match, so add that property.
    expect(
      areNormalizedLinksSame(
        parseLink((result.getRaw() as { output: unknown }).output, result)!,
        { ...outputLink, overwrite: "redirect" },
      ),
    ).toBe(true);
  });

  it("should work with nested patterns", async () => {
    const innerPattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
      },
      resultSchema: {},
      result: { $alias: { partialCause: "output", path: [], defer: 1 } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: {
            value: {
              $alias: { cell: "argument", path: ["input"], defer: 1 },
            },
          },
          outputs: {
            value: {
              $alias: { partialCause: "output", path: [], defer: 1 },
            },
          },
        },
      ],
    } as Pattern;

    const outerPattern = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
          result: { type: "number" },
        },
      },
      resultSchema: {},
      result: { result: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "pattern", implementation: innerPattern },
          inputs: { input: { $alias: { cell: "argument", path: ["value"] } } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "should work with nested patterns",
    );
    const result = runTrusted(
      runtime,
      undefined,
      outerPattern,
      { value: 5 },
      resultCell,
    );

    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: 5 });
  });

  it("should run a simple module", async () => {
    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "should run a simple module",
      undefined,
      tx,
    );
    const result = runTrusted(
      runtime,
      tx,
      mockPattern,
      { value: 1 },
      resultCell,
    );
    tx.commit();

    const resultValue = await result.pull();
    expect(JSON.stringify(resultValue)).toEqual(
      JSON.stringify({ result: 2 }),
    );
  });

  it("registers a dormant module without reading linked input data", async () => {
    let runs = 0;
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (input: number) => {
              runs++;
              return input * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    };

    const setupTx = runtime.edit();
    const source = runtime.getCell<{ value: number }>(
      space,
      "dormant registration source",
      {
        type: "object",
        properties: { value: { type: "number" } },
      },
      setupTx,
    );
    source.set({ value: 21 });
    const sourceLink = source.getAsNormalizedFullLink();
    const resultCell = runtime.getCell(
      space,
      "dormant registration result",
      undefined,
      setupTx,
    );

    runTrusted(
      runtime,
      setupTx,
      pattern,
      { input: source.key("value").getAsWriteRedirectLink() },
      resultCell,
    );
    await setupTx.commit();

    let sourceDataReads = 0;
    const countSourceRead = (
      address: { space?: unknown; id?: unknown },
    ): void => {
      if (address.space === sourceLink.space && address.id === sourceLink.id) {
        sourceDataReads++;
      }
    };
    const originalEdit = runtime.edit.bind(runtime) as Runtime["edit"];
    runtime.edit = ((...args: Parameters<Runtime["edit"]>) => {
      const actionTx = originalEdit(...args);
      const originalRead = actionTx.read.bind(actionTx);
      actionTx.read = ((address, options) => {
        countSourceRead(address);
        return originalRead(address, options);
      }) as typeof actionTx.read;
      const originalReadOrThrow = actionTx.readOrThrow.bind(actionTx);
      actionTx.readOrThrow = ((address, options) => {
        countSourceRead(address);
        return originalReadOrThrow(address, options);
      }) as typeof actionTx.readOrThrow;
      return actionTx;
    }) as Runtime["edit"];

    try {
      await runtime.idle();
    } finally {
      runtime.edit = originalEdit;
    }

    expect(runs).toBe(0);
    expect(sourceDataReads).toBe(0);
  });

  it("should run a simple module with no outputs", async () => {
    let ran = false;

    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should run a simple module with no outputs",
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, mockPattern),
      {
        value: 1,
      },
    );
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: undefined });
    expect(ran).toBe(true);
  });

  it("should handle incorrect inputs gracefully", async () => {
    let ran = false;

    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["other"] } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should handle incorrect inputs gracefully",
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, mockPattern),
      {
        value: 1,
      },
    );
    const resultValue2 = await result.pull();
    expect(resultValue2).toEqual({ result: undefined });
    // We don't run the action if the arguments fail to validate
    expect(ran).toBe(false);
  });

  it("should handle nested patterns", async () => {
    const nestedPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { $alias: { partialCause: "result", path: [], defer: 1 } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: {
            $alias: { cell: "argument", path: ["input"], defer: 1 },
          },
          outputs: {
            $alias: { partialCause: "result", path: [], defer: 1 },
          },
        },
      ],
    };

    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: { type: "pattern", implementation: nestedPattern },
          inputs: { input: { $alias: { cell: "argument", path: ["value"] } } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should handle nested patterns",
    );
    const result = runTrusted(
      runtime,
      undefined,
      mockPattern,
      { value: 1 },
      resultCell,
    );
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: 2 });
  });

  it("should allow passing a cell as a binding", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { cell: "argument", path: ["output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { cell: "argument", path: ["output"] } },
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

    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      inputCell,
      resultCell,
    );

    const inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 10, output: 20 });
    let resultValue = await result.pull();
    expect(resultValue).toEqual({ output: 20 });

    // The result should alias the original cell. Let's verify by stopping the
    // pattern and sending a new value to the input cell.
    runtime.runner.stop(result);

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 10, output: 40 });
    await tx2.commit();

    resultValue = await result.pull();
    expect(resultValue).toEqual({ output: 40 });
  });

  it("should allow stopping a pattern", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { cell: "argument", path: ["output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { cell: "argument", path: ["output"] } },
        },
      ],
    };

    const tx = runtime.edit();
    const inputCell = runtime.getCell<{ input: number; output: number }>(
      space,
      "should allow stopping a pattern: input cell",
      undefined,
      tx,
    );
    inputCell.set({ input: 10, output: 0 });
    const resultCell = runtime.getCell(
      space,
      "should allow stopping a pattern",
      undefined,
      tx,
    );

    // Commit the initial values before running the pattern
    await tx.commit();

    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      inputCell,
      resultCell,
    );

    let inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 10, output: 20 });

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 20, output: 20 });
    await tx2.commit();

    inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 20, output: 40 });

    // Stop the pattern
    runtime.runner.stop(result);

    const tx3 = runtime.edit();
    inputCell.withTx(tx3).send({ input: 40, output: 40 });
    await tx3.commit();

    inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 40, output: 40 });

    // Restart the pattern
    runTrusted(runtime, undefined, pattern, undefined, result);

    inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 40, output: 80 });
  });

  it("should apply default values from argument schema", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number", default: 42 },
          multiplier: { type: "number", default: 2 },
        },
        required: ["input"],
      },
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number; multiplier: number }) =>
              args.input * args.multiplier,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    // Test with partial arguments (should use default for multiplier)
    const resultWithPartialCell = runtime.getCell(
      space,
      "default values test - partial",
    );

    const resultWithPartial = runTrusted(runtime, undefined, pattern, {
      input: 10,
    }, resultWithPartialCell);
    const partialValue = await resultWithPartial.pull();
    expect(partialValue).toEqual({ result: 20 });

    // Test with no arguments (should use default for input)
    const resultWithDefaultsCell = runtime.getCell(
      space,
      "default values test - all defaults",
    );

    const resultWithDefaults = runTrusted(
      runtime,
      undefined,
      pattern,
      {},
      resultWithDefaultsCell,
    );
    const defaultsValue = await resultWithDefaults.pull();
    expect(defaultsValue).toEqual({ result: 84 }); // 42 * 2
  });

  it("should handle complex nested schema types", async () => {
    const pattern: Pattern = {
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
      result: { result: { $alias: { partialCause: "result", path: [] } } },
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
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "complex schema test",
    );
    const result = runTrusted(runtime, undefined, pattern, {
      config: { values: [10, 20, 30, 40], operation: "avg" },
    }, resultCell);
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: 25 });

    // Test with a different operation
    const result2 = runTrusted(runtime, undefined, pattern, {
      config: { values: [10, 20, 30, 40], operation: "max" },
    }, resultCell);
    const result2Value = await result2.pull();
    expect(result2Value).toEqual({ result: 40 });
  });

  it("should merge arguments with defaults from schema", async () => {
    const pattern: Pattern = {
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
        result: { $alias: { partialCause: "result", path: [] } },
        options: { $alias: { cell: "argument", path: ["options"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number; options: any }) => {
              return args.options.enabled ? args.input * args.options.value : 0;
            },
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    // Provide partial options - should merge with defaults
    const resultCell = runtime.getCell(
      space,
      "merge defaults test",
    );
    const result = runTrusted(runtime, undefined, pattern, {
      options: { value: 10 },
      input: 5,
    }, resultCell);

    const resultValue = await result.pull() as any;
    expect(resultValue.options).toEqual({
      enabled: true,
      value: 10,
      name: "default",
    });
    expect(resultValue.result).toEqual(50); // 5 * 10
  });

  it("should preserve NAME between runs", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      derivedInternalCells: [{
        partialCause: "counter",
        schema: { default: 0 },
      }],
      result: {
        [NAME]: "counter",
        counter: { $alias: { partialCause: "counter", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (input: any) => {
              return input.value;
            },
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "counter", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell<any>(
      space,
      "state preservation test",
    );

    // First run
    runTrusted(runtime, undefined, pattern, { value: 1 }, resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("counter");
    expect(cellValue?.counter).toEqual(1);

    // Now change the name
    const tx = runtime.edit();
    resultCell.withTx(tx).update({ [NAME]: "my counter" });
    await tx.commit();

    // Second run with same pattern but different argument
    runTrusted(runtime, undefined, pattern, { value: 2 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("my counter");
    expect(cellValue?.counter).toEqual(2);
  });

  it("should refresh NAME when the pattern changes", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      derivedInternalCells: [{
        partialCause: "counter",
        schema: { default: 0 },
      }],
      result: {
        [NAME]: "counter",
        counter: { $alias: { partialCause: "counter", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (input: any) => input.value,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "counter", path: [] } },
        },
      ],
    };

    const renamedPattern: Pattern = {
      ...pattern,
      result: {
        [NAME]: "renamed counter",
        counter: { $alias: { partialCause: "counter", path: [] } },
      },
    };

    const resultCell = runtime.getCell<any>(
      space,
      "state preservation across pattern changes test",
    );

    runTrusted(runtime, undefined, pattern, { value: 1 }, resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("counter");
    expect(cellValue?.counter).toEqual(1);

    runTrusted(runtime, undefined, renamedPattern, { value: 2 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("renamed counter");
    expect(cellValue?.counter).toEqual(2);
  });

  it("should create separate copies of initial values (frozen)", async () => {
    // `getRaw()` returns frozen objects; verify independence via
    // `getRawUntyped({ frozen: false })` for mutable access.
    const sm = StorageManager.emulate({ as: signer });
    const localRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });

    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
        },
      },
      derivedInternalCells: [
        {
          partialCause: "nested",
          scope: "space",
          schema: { default: { value: "initial" } },
        },
        {
          partialCause: "counter",
          scope: "space",
          schema: { default: 10 },
        },
      ],
      resultSchema: {},
      result: {
        counter: { $alias: { partialCause: "counter", path: [] } },
        nested: { $alias: { partialCause: "nested", path: [] } },
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
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { partialCause: "counter", path: [] } },
        },
      ],
    };

    // Create first instance
    const result1Cell = localRuntime.getCell(
      space,
      "separate copies modern 1",
    );
    const result1 = runTrusted(
      localRuntime,
      undefined,
      pattern,
      { input: 5 },
      result1Cell,
    );
    await result1.pull();

    // Create second instance
    const result2Cell = localRuntime.getCell(
      space,
      "separate copies modern 2",
    );
    const result2 = runTrusted(
      localRuntime,
      undefined,
      pattern,
      { input: 10 },
      result2Cell,
    );
    await result2.pull();

    // Use getRawUntyped({ frozen: false }) for mutable copies
    const internalCell1 = getDerivedInternalCell(result1, {
      partialCause: "nested",
    });
    const internalCell2 = getDerivedInternalCell(result2, {
      partialCause: "nested",
    });
    const nested1 = internalCell1.getRawUntyped({ frozen: false }) as any;
    const nested2 = internalCell2.getRawUntyped({ frozen: false }) as any;

    // Verify they are different objects
    expect(nested1).not.toBe(nested2);

    // Modify nested object in first instance's mutable copy
    nested1.value = "modified";

    // Verify second instance is unaffected
    expect(nested2.value).toBe("initial");

    await localRuntime.storageManager.synced();
    await localRuntime.dispose();
    await sm.close();
  });

  it("materializes derived internal defaults from descriptor schemas", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      derivedInternalCells: [
        {
          partialCause: "history",
          schema: { type: "array", default: [] },
        },
        {
          partialCause: "count",
          schema: { type: "number", default: 0 },
        },
      ],
      resultSchema: {
        type: "object",
        properties: {
          history: { type: "array" },
          count: { type: "number" },
        },
      },
      result: {
        history: { $alias: { partialCause: "history", path: [] } },
        count: { $alias: { partialCause: "count", path: [] } },
      },
      nodes: [],
    };

    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      {},
      runtime.getCell(space, "schema default derived internals"),
    );

    expect(await result.key("history").pull()).toEqual([]);
    expect(await result.key("count").pull()).toBe(0);
    expect(
      getDerivedInternalCell(result, {
        partialCause: "history",
        schema: { type: "array", default: [] },
      }).getRawUntyped(),
    ).toEqual([]);
  });
});

describe("storage subscription", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("clears cached patterns when storage notifies of changes", () => {
    const internals = runtime.runner as unknown as {
      resultPatternCache: Map<string, string>;
      createStorageSubscription(): IStorageSubscription;
    };

    const uri = "pattern-cache-test" as URI;
    const key = `${space}/space/${uri}`;
    internals.resultPatternCache.set(key, "cached-pattern");

    const notification = {
      type: "commit",
      space,
      changes: [
        {
          address: {
            id: uri,
            type: "application/json" as MediaType,
            path: [],
          },
          before: undefined,
          after: undefined,
        },
      ],
    } satisfies ICommitNotification;

    const subscription = internals.createStorageSubscription();
    subscription.next(notification);

    expect(internals.resultPatternCache.has(key)).toBe(false);
  });
});

describe("setup/start", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("setup does not schedule; start schedules and runs", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "setup does not schedule");

    // Only setup – should not run the node yet
    setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);

    // Output hasn't been computed yet
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: undefined });

    // Start – should schedule and compute output
    runtime.start(resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 1 });
  });

  it("reports a missing stream marker when a handler's $event reads undefined", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: {
            $event: { $alias: { cell: "argument", path: ["missingStream"] } },
          },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "handler $event reads undefined",
    );
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    // The node is authored as a handler but its stream marker location was
    // never written (e.g. state persisted in an older format). The error must
    // say the marker is missing, not that it was overwritten.
    const error = await runtime.start(resultCell).then(
      () => undefined,
      (e) => e as Error,
    );
    expect(error?.message).toContain("was never written");
    // This piece's internal meta is the modern manifest (an array), so the
    // pre-manifest hint must not fire on it.
    expect(error?.message).not.toContain("pre-manifest");
  });

  it("reports an overwritten stream marker when $event resolves to data", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { ev: { type: "number" } },
      },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: { $alias: { cell: "argument", path: ["ev"] } } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "handler $event resolves to data",
    );
    setupTrusted(runtime, undefined, pattern, { ev: 7 }, resultCell);

    await expect(runtime.start(resultCell)).rejects.toThrow(
      "was overwritten (found: 7)",
    );
  });

  it("reports a non-link $event input on a handler node", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: 42 },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(space, "handler $event is not a link");
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    await expect(runtime.start(resultCell)).rejects.toThrow(
      "is not a stream reference",
    );
  });

  it("hints at the pre-manifest format when internal meta is a single-cell link", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: {
            $event: { $alias: { cell: "argument", path: ["missingStream"] } },
          },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "pre-manifest internal meta hint",
    );
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    // Simulate a piece persisted before the internal-cell manifest format
    // (#3911): its `internal` meta is a single cell link rather than the
    // manifest array the modern setup path writes.
    const legacyInternalCell = runtime.getCell(
      space,
      "pre-manifest single internal cell",
    );
    const metaTx = runtime.edit();
    resultCell.withTx(metaTx).setMetaRaw(
      "internal",
      legacyInternalCell.getAsWriteRedirectLink({ base: resultCell }),
    );
    await metaTx.commit();

    const error = await runtime.start(resultCell).then(
      () => undefined,
      (e) => e as Error,
    );
    expect(error?.message).toContain("was never written");
    // The non-array internal meta is the discriminator for the pre-manifest
    // format; the hint and its remedy must both surface.
    expect(error?.message).toContain("pre-manifest format");
    expect(error?.message).toContain("recreate the piece");
  });

  it("truncates long values in the overwritten-marker diagnostic", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { ev: { type: "string" } },
      },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: { $alias: { cell: "argument", path: ["ev"] } } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "handler $event resolves to a long value",
    );
    setupTrusted(
      runtime,
      undefined,
      pattern,
      { ev: "x".repeat(200) },
      resultCell,
    );

    // The diagnostic prints the offending value but must stay bounded:
    // toCompactDebugString caps it at 80 characters with an ellipsis, so an
    // error message never dumps a large payload.
    const error = await runtime.start(resultCell).then(
      () => undefined,
      (e) => e as Error,
    );
    expect(error?.message).toContain("was overwritten (found: ");
    expect(error?.message).toContain("...");
    expect(error?.message).not.toContain("x".repeat(100));
  });

  it("start() leaves no running registration when instantiation throws", async () => {
    // A handler node whose $event input does not resolve to a stream marker
    // (e.g. persisted state in an older format) makes node instantiation
    // throw "Handler used as lift".
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: 42 },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "start cleans up when instantiation throws",
    );
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    await expect(runtime.start(resultCell)).rejects.toThrow(
      "Handler used as lift",
    );

    // Regression: the failed start used to leave the piece registered as
    // running, so a second start() reported success for a piece that had no
    // nodes or event handlers — events sent to it were silently dropped. It
    // must fail the same way as the first attempt instead.
    await expect(runtime.start(resultCell)).rejects.toThrow(
      "Handler used as lift",
    );
  });

  it("run() with a given pattern leaves no running registration when instantiation throws", () => {
    // Same regression as above, via the fresh-run entry (the path a live
    // `cf piece new` takes): startCore's givenPattern branch must also clean
    // up when node instantiation throws.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: 42 },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "fresh run cleans up when instantiation throws",
    );

    expect(() => runTrusted(runtime, undefined, pattern, {}, resultCell))
      .toThrow("Handler used as lift");

    // A zombie registration would make the second run() short-circuit to
    // "already running" and return without error. It must throw identically.
    expect(() => runTrusted(runtime, undefined, pattern, {}, resultCell))
      .toThrow("Handler used as lift");
  });

  it("setup ignores exhausted retry errors and still resolves", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [],
    };

    const resultCell = runtime.getCell(space, "setup ignores retry errors");
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    runtime.editWithRetry = (() =>
      Promise.resolve({
        error: {
          name: "StorageTransactionAborted" as const,
          message: "always-fail",
          reason: "always-fail",
        },
      })) as typeof runtime.editWithRetry;

    try {
      await expect(runtime.setup(undefined, pattern, { input: 1 }, resultCell))
        .resolves.toBe(resultCell);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("setup rethrows callback failures from editWithRetry", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [],
    };

    const resultCell = runtime.getCell(space, "setup rethrows callback errors");
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const thrown = new Error("boom");
    runtime.editWithRetry = (() =>
      Promise.resolve({
        error: {
          name: "StorageTransactionAborted" as const,
          message: `editWithRetry action threw: ${thrown}`,
          reason: thrown,
        },
      })) as typeof runtime.editWithRetry;

    try {
      await expect(runtime.setup(undefined, pattern, { input: 1 }, resultCell))
        .rejects.toThrow("boom");
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("setup with same pattern updates argument without restart", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "setup updates argument");
    setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);
    runtime.start(resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 1 });

    // Update only via setup; scheduler should react to argument change
    setupTrusted(runtime, undefined, pattern, { input: 2 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 2 });
  });

  it("start is idempotent when called multiple times", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (v: { input: number }) => v.input,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "start idempotent");
    setupTrusted(runtime, undefined, pattern, { input: 7 }, resultCell);
    runtime.start(resultCell);
    runtime.start(resultCell);

    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 7 });

    // Change input and ensure only a single recomputation occurs in effect
    setupTrusted(runtime, undefined, pattern, { input: 9 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 9 });
  });

  it("stop and restart works with setup/start", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (v: { input: number }) => v.input,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "stop and restart");
    setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);
    runtime.start(resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 1 });

    // Stop the scheduling
    runtime.runner.stop(resultCell);

    // Change argument via setup; without start nothing should recompute yet
    setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);
    cellValue = await resultCell.pull();
    // Still the old output
    expect(cellValue).toEqual({ output: 1 });

    // Restart
    runtime.start(resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 5 });
  });

  it("setup with Module wraps to pattern and runs on start", async () => {
    const mod = {
      type: "javascript" as const,
      implementation: (v: { input: number }) => ({ output: v.input * 3 }),
    };

    const resultCell = runtime.getCell(space, "setup with module");
    setupTrusted(
      runtime,
      undefined,
      mod as any,
      { input: 2 } as any,
      resultCell,
    );

    // Not started yet; no output
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual(undefined);

    runtime.start(resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 6 });
  });

  it("setup without pattern reuses previous pattern", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "setup reuse previous pattern");
    setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);
    runtime.start(resultCell);
    const cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 5 });

    // Stop and setup without specifying pattern; should reuse stored one
    runtime.runner.stop(resultCell);
    setupTrusted(
      runtime,
      undefined,
      undefined as any,
      { input: 10 } as any,
      resultCell,
    );
    // Not started yet; result still aliases internal and shows previous value
    const rawValue = resultCell.get();
    expect(rawValue).toMatchObjectIgnoringSymbols({
      output: { $alias: { partialCause: "output", path: [] } },
    });

    // Verify the pattern identity pointer is present after setup without
    // passing the pattern (it was reused from the stored pointer).
    const patternValue = resultCell.getMetaRaw("patternIdentity");
    expect(patternValue).toBeDefined();

    // Also verify the argument metadata cell was updated
    await resultCell.pull();
    const argumentValue = runtime.getCellFromLink<{ input: number }>(
      getMetaLink(resultCell, "argument")!,
    ).get();
    expect(argumentValue.input).toEqual(10);

    // Start again (scheduling) just to ensure no errors
    runtime.start(resultCell);
    await resultCell.pull();
  });

  it("setup with cell argument and start reacts to cell updates", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { cell: "argument", path: ["output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { cell: "argument", path: ["output"] } },
        },
      ],
    };

    const tx = runtime.edit();
    const inputCell = runtime.getCell<{ input: number; output: number }>(
      space,
      "setup with cell arg: input",
      undefined,
      tx,
    );
    inputCell.set({ input: 3, output: 0 });
    await tx.commit();

    const resultCell = runtime.getCell(space, "setup with cell arg");
    setupTrusted(runtime, undefined, pattern, inputCell, resultCell);
    runtime.start(resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 6 });

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 4, output: 0 });
    await tx2.commit();
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 8 });
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
      apiUrl: new URL(import.meta.url),
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

  describe("start() lazy sync behavior", () => {
    it("start() returns Promise<boolean> that resolves to true", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 2,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start returns promise");
      setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);
      const result = await runtime.start(resultCell);
      expect(result).toBe(true);
      await resultCell.pull();
      await runtime.idle();
      expect(resultCell.getAsQueryResult()).toEqual({ output: 10 });
    });

    it("start() returns true immediately if already running", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start idempotent");
      setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);
      await runtime.start(resultCell);
      await runtime.idle();

      // Second call should return true immediately
      const result = await runtime.start(resultCell);
      expect(result).toBe(true);
    });

    it("does not register duplicate handlers while resumed dependencies sync", async () => {
      const valueAlias = {
        $alias: {
          cell: "argument",
          path: ["value"],
          scope: "space",
          schema: { type: "number", default: 0 },
        },
      };
      const streamAlias = {
        $alias: {
          partialCause: { stream: "increment" },
          path: [],
          scope: "space",
          schema: true,
        },
      };
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: {
            value: {
              type: "number",
              default: 0,
              asCell: ["cell"],
            },
          },
        },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: "number" },
            increment: { asCell: ["stream", "opaque"] },
          },
        },
        derivedInternalCells: [
          {
            partialCause: { stream: "increment" },
            schema: { default: { $stream: true } },
            scope: "space",
          },
        ],
        result: {
          value: valueAlias,
          increment: streamAlias,
        },
        nodes: [
          {
            module: {
              type: "javascript",
              wrapper: "handler",
              argumentSchema: {
                type: "object",
                properties: {
                  $event: false,
                  $ctx: {
                    type: "object",
                    properties: {
                      value: {
                        type: "number",
                        asCell: ["cell"],
                      },
                    },
                    required: ["value"],
                  },
                },
                required: ["$ctx"],
              },
              implementation: (_event: unknown, { value }: any) => {
                value.set(value.get() + 1);
              },
            },
            inputs: {
              $ctx: { value: valueAlias },
              $event: streamAlias,
            },
            outputs: {},
          },
        ],
      };

      const resultCell = runtime.getCell<any>(
        space,
        "concurrent start dedupe",
      );
      await setupTrusted(runtime, undefined, pattern, { value: 0 }, resultCell);

      // Simulate a persisted piece being resumed. In that path start() syncs
      // dependencies before registering handlers, which is where this race
      // used to allow duplicate starts for the same result cell.
      (runtime.runner as any).locallyPreparedResults.clear();
      (resultCell as any).synced = true;

      const runner = runtime.runner as any;
      const originalSync = runner.syncCellsForRunningPattern.bind(runner);
      runner.syncCellsForRunningPattern = async (...args: any[]) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return originalSync(...args);
      };

      try {
        const [first, second] = await Promise.all([
          runtime.start(resultCell),
          runtime.start(resultCell),
        ]);
        expect(first).toBe(true);
        expect(second).toBe(true);

        resultCell.key("increment").send();
        await runtime.idle();
        await resultCell.pull();

        expect(resultCell.key("value").get()).toBe(1);
      } finally {
        runner.syncCellsForRunningPattern = originalSync;
      }
    });

    it("start() runs synchronously when data is available", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 3,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start sync behavior");
      setupTrusted(runtime, undefined, pattern, { input: 4 }, resultCell);

      // start() should execute synchronously when data is available
      // The piece should be registered in cancels map immediately
      const started = runtime.start(resultCell);
      // Should be running now (check via runner.cancels having the key)
      expect(
        runtime.runner["cancels"].has(runtime.runner["getDocKey"](resultCell)),
      ).toBe(true);

      expect(await started).toBe(true);
      await resultCell.pull();
      await runtime.idle();
      expect(resultCell.getAsQueryResult()).toEqual({ output: 12 });
    });

    it("start() on subpath cell starts the root cell", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: {
          nested: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 2,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start subpath cell");
      setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);

      // Get a subpath cell
      const subpathCell = resultCell.key("nested").key("value");

      // Start via the subpath cell - should start the root
      const result = await runtime.start(subpathCell);
      expect(result).toBe(true);

      await subpathCell.pull();
      await runtime.idle();
      expect(resultCell.getAsQueryResult()).toEqual({ nested: { value: 10 } });

      // Verify root cell is running
      expect(
        runtime.runner["cancels"].has(runtime.runner["getDocKey"](resultCell)),
      ).toBe(true);
    });

    it("restarts with new pattern when the pattern changes via setup()", async () => {
      const pattern1: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 2,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const pattern2: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 10,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "pattern change restart");

      // Run with first pattern
      runTrusted(runtime, undefined, pattern1, { input: 5 }, resultCell);
      expect(await resultCell.pull()).toEqual({ output: 10 }); // 5 * 2

      // Change pattern via setup (not run or start)
      // The pattern sink should detect the change and restart once the result is pulled.
      await setupTrusted(
        runtime,
        undefined,
        pattern2,
        { input: 5 },
        resultCell,
      );
      expect(await resultCell.pull()).toEqual({ output: 50 }); // 5 * 10
    });
  });
});

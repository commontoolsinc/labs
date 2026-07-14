import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  NAME,
  Pattern,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { defer } from "@commonfabric/utils/defer";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  validateAgainstSchema,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import { PieceManager } from "../src/manager.ts";
import { PieceController } from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece pull materialization");

function doublePattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function tenfoldPattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 10,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function namedPattern(name: string, multiplier: number): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        [NAME]: { type: "string" },
        output: { type: "number" },
      },
      required: [NAME, "output"],
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      [NAME]: name,
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * multiplier,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function compiledMultiplierProgram(
  version: string,
  multiplier: number,
): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          `const multiply = lift((input: number) => input * ${multiplier});`,
          "export default pattern<{ input: number }>(({ input }) => ({",
          `  version: ${JSON.stringify(version)},`,
          "  output: multiply(input),",
          "}));",
        ].join("\n"),
      },
    ],
  };
}

function compiledSchemaEvolutionProgram(version: 1 | 2 | 3): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "interface Output { doubled: number; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "}));",
    ]
    : version === 2
    ? [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; }",
      "interface Input {",
      "  value: number;",
      "  label?: string;",
      "  retries: number | Default<0>;",
      "  options: Options;",
      "  mode?: string | number;",
      "}",
      "interface Output { doubled: number; summary?: string; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "  summary: 'updated',",
      "}));",
    ]
    : [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: string; }",
      "interface Output { doubled: string; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "}));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledResultNarrowingProgram(
  resultType:
    | "string | number | boolean"
    | "string | number"
    | "string"
    | "number",
): RuntimeProgram {
  const value = resultType === "string" ? "String(input)" : "input";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Input { input: number; }",
        `interface Output { value: ${resultType}; }`,
        "export default pattern<Input, Output>(({ input }) => ({",
        `  value: ${value},`,
        "}));",
      ].join("\n"),
    }],
  };
}

function compiledOptionalPartialDefaultProgram(
  version: 1 | 2,
): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ]
    : [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; name: string; }",
      "interface Input { value: number; options?: Options; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledOptionalNumberFieldProgram(version: 1 | 2): RuntimeProgram {
  const input = version === 1
    ? "interface Input { value: number; }"
    : "interface Input { value: number; mode?: number; }";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        input,
        "export default pattern<Input>(({ value }) => ({ value }));",
      ].join("\n"),
    }],
  };
}

function compiledDefaultedOptionsProgram(version: 1 | 2): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ]
    : [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; }",
      "interface Input { value: number; options?: Options; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function linkedSettingsSourcePattern(): Pattern {
  return {
    argumentSchema: { type: "object" },
    resultSchema: {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: { mode: { type: "string" } },
          required: ["mode"],
        },
      },
      required: ["settings"],
    },
    result: { settings: { mode: "linked" } },
    nodes: [],
  };
}

function compiledLinkedSettingsProgram(version: 1 | 2): RuntimeProgram {
  const attempts = version === 1 ? "" : "  attempts?: number | Default<1>;";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        `import { ${
          version === 1 ? "pattern" : "Default, pattern"
        } } from 'commonfabric';`,
        "interface Settings {",
        "  mode: string;",
        attempts,
        "}",
        "interface Input { settings: Settings; }",
        "export default pattern<Input>(({ settings }) => ({",
        "  mode: settings.mode,",
        "}));",
      ].filter(Boolean).join("\n"),
    }],
  };
}

function trustPattern(runtime: Runtime, pattern: Pattern): Pattern {
  return runtime.unsafeTrustPattern(pattern, {
    reason: "piece pull materialization test fixture",
  });
}

describe("piece pull materialization", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "pull-materialization-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("pulls before reading result values", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();

    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).key("input").set(7);
    });

    expect(await controller.result.get(["output"])).toBe(14);
  });

  it("materializes piece results before setInput returns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.setInput({ input: 7 });

    expect(manager.getResult(piece).get()).toEqual({ output: 14 });
  });

  it("materializes piece results before runWithPattern returns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 10 });

    await manager.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("persists setPattern replacement by identity for fresh runtime reloads", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { input: 5 },
      "compiled-set-pattern-" + crypto.randomUUID(),
      { start: true },
    );
    const id = entityRefToString(piece.entityId);
    const controller = new PieceController(manager, piece);
    const firstRef = getPatternIdentityRef(piece);

    expect(firstRef).toBeDefined();
    expect(manager.getResult(piece).get()).toEqual({
      version: "v1",
      output: 10,
    });

    await controller.setPattern(compiledMultiplierProgram("v2", 10));
    await manager.runtime.idle();
    await manager.synced();

    const secondRef = getPatternIdentityRef(piece);
    expect(secondRef).toBeDefined();
    expect(secondRef!.identity).not.toEqual(firstRef!.identity);
    expect(manager.getResult(piece).get()).toEqual({
      version: "v2",
      output: 50,
    });

    const session = await createSession({
      identity: signer,
      spaceName: manager.getSpaceName()!,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const freshManager = new PieceManager(session, freshRuntime);
    const freshPieces = new PiecesController(freshManager);

    try {
      await freshManager.synced();
      const freshPiece = await freshPieces.get(id, true);
      const freshCell = freshPiece.getCell();
      const freshRef = getPatternIdentityRef(freshCell);

      expect(freshRef).toEqual(secondRef);
      expect(await freshPiece.result.get()).toEqual({
        version: "v2",
        output: 50,
      });
      const source = await freshPiece.getPatternSourceProgram();
      expect(source?.files.some((file) => file.contents.includes("v2"))).toBe(
        true,
      );
    } finally {
      await freshRuntime.dispose();
    }
  });

  it("updates a piece across backward-compatible schema additions", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "compatible-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    expect(await controller.input.get()).toEqual({ value: 4 });
    expect(await controller.result.get()).toEqual({ doubled: 4 });

    await controller.setPattern(compiledSchemaEvolutionProgram(2));

    const updatedPattern = await controller.getPattern();
    expect(updatedPattern.result).toMatchObject({ summary: "updated" });
    const inputProperties = updatedPattern.argumentSchema &&
        typeof updatedPattern.argumentSchema === "object"
      ? updatedPattern.argumentSchema.properties
      : undefined;
    expect(inputProperties?.mode).toMatchObject({
      type: ["number", "string"],
    });
    expect(await controller.input.get()).toEqual({
      value: 4,
      retries: 0,
      options: { attempts: 1 },
    });
    const rawInput = (await controller.input.getCell()).getRaw();
    expect(rawInput).toEqual({
      value: 4,
      retries: 0,
      options: { attempts: 1 },
    });
    expect(validateAgainstSchema(updatedPattern.argumentSchema, rawInput))
      .toBeUndefined();
    expect(await controller.result.get()).toEqual({
      doubled: 4,
      summary: "updated",
    });
  });

  it("updates a piece whose durable arguments contain links", async () => {
    const source = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      "linked-update-source-" + crypto.randomUUID(),
      { start: true },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: manager.getSpace() },
    );
    const target = await manager.runPersistent(
      firstPattern,
      { input: 1 },
      "linked-update-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await manager.link(
      entityRefToString(source.entityId),
      ["output"],
      entityRefToString(target.entityId),
      ["input"],
    );

    expect(await controller.input.get()).toEqual({ input: 10 });
    expect(await controller.result.get()).toEqual({
      version: "v1",
      output: 20,
    });
    const rawBefore = (await controller.input.getCell()).getRaw();
    expect(rawBefore).not.toEqual({ input: 10 });

    await controller.setPattern(compiledMultiplierProgram("v2", 10));

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({ input: 10 });
    expect(await controller.result.get()).toEqual({
      version: "v2",
      output: 100,
    });
  });

  it("preserves linked objects while adding nested defaults", async () => {
    const source = await manager.runPersistent(
      trustPattern(runtime, linkedSettingsSourcePattern()),
      {},
      "linked-object-default-source-" + crypto.randomUUID(),
      { start: true },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(1),
      { space: manager.getSpace() },
    );
    const target = await manager.runPersistent(
      firstPattern,
      { settings: { mode: "local" } },
      "linked-object-default-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, target);

    await manager.link(
      entityRefToString(source.entityId),
      ["settings"],
      entityRefToString(target.entityId),
      ["settings"],
    );
    const rawBefore = (await controller.input.getCell()).getRaw();
    expect(await controller.input.get()).toMatchObject({
      settings: { mode: "linked" },
    });

    await controller.setPattern(compiledLinkedSettingsProgram(2));

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toMatchObject({
      settings: { mode: "linked" },
    });
    expect(await controller.result.get()).toEqual({ mode: "linked" });
  });

  it("rejects an incompatible schema update before changing the piece", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "incompatible-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const previousRef = getPatternIdentityRef(controller.getCell());

    await expect(
      controller.setPattern(compiledSchemaEvolutionProgram(3)),
    ).rejects.toThrow(/not backward compatible/);

    expect(getPatternIdentityRef(controller.getCell())).toEqual(previousRef);
    expect(await controller.input.get()).toEqual({ value: 4 });
    expect(await controller.result.get()).toEqual({ doubled: 4 });
  });

  it("does not hydrate an invalid partial default into an optional object", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalPartialDefaultProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-partial-default-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.setPattern(compiledOptionalPartialDefaultProgram(2));

    const updatedPattern = await controller.getPattern();
    const rawInput = (await controller.input.getCell()).getRaw();
    expect(rawInput).toEqual({ value: 4 });
    expect(validateSchemaValue(updatedPattern.argumentSchema, rawInput))
      .toBeUndefined();
  });

  it("does not hydrate an invalid partial ref default on first start", async () => {
    const pattern = await runtime.patternManager.compilePattern(
      compiledOptionalPartialDefaultProgram(2),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      pattern,
      { value: 4 },
      "optional-partial-default-first-start-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const rawInput = (await controller.input.getCell()).getRaw();

    expect(rawInput).toEqual({ value: 4 });
    expect(validateSchemaValue(pattern.argumentSchema, rawInput))
      .toBeUndefined();
  });

  it("preserves conflicting defined values while merging object defaults", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledDefaultedOptionsProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "defined-object-default-conflict-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).setRawUntyped({
        value: 4,
        options: "legacy",
      });
    });
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledDefaultedOptionsProgram(2)),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual({ value: 4, options: "legacy" });
  });

  it("rejects an optional field update that conflicts with durable raw args", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-field-conflict-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).setRawUntyped({
        value: 4,
        mode: "legacy-string",
      });
    });
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual({ value: 4, mode: "legacy-string" });
  });

  it("rejects a source update whose validated pattern identity became stale", async () => {
    const initialProgram = compiledResultNarrowingProgram("string | number");
    const stringProgram = compiledResultNarrowingProgram("string");
    const numberProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const stringPattern = await runtime.patternManager.compilePattern(
      stringProgram,
      { space: manager.getSpace() },
    );
    const numberPattern = await runtime.patternManager.compilePattern(
      numberProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 4 },
      "concurrent-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const compileEntered = defer<void>();
    const releaseCompile = defer<void>();
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === stringProgram) {
        compileEntered.resolve();
        await releaseCompile.promise;
        return stringPattern;
      }
      if (program === numberProgram) return numberPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const staleUpdate = expect(controller.setPattern(stringProgram)).rejects
        .toThrow(/pattern changed while the source update was compiling/);
      await compileEntered.promise;
      await controller.setPattern(numberProgram);
      releaseCompile.resolve();
      await staleUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(numberPattern),
      );
      expect(await controller.result.get()).toEqual({ value: 4 });

      await expect(
        manager.runWithPattern(numberPattern, controller.id, undefined, {
          start: false,
          expectedPatternIdentity: getPatternIdentityRef(piece),
        }),
      ).rejects.toThrow(/atomic pattern updates require starting the piece/);
    } finally {
      releaseCompile.resolve();
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("rechecks the expected identity after a real commit-conflict retry", async () => {
    const initialProgram = compiledMultiplierProgram("initial", 1);
    const staleProgram = compiledMultiplierProgram("stale", 2);
    const winnerProgram = compiledMultiplierProgram("winner", 10);
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const stalePattern = await runtime.patternManager.compilePattern(
      staleProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "commit-conflict-update-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const commitEntered = defer<void>();
    const releaseCommit = defer<void>();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptNextCommit = true;
    runtime.editWithRetry =
      ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptNextCommit) {
            interceptNextCommit = false;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof runtime.editWithRetry;
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === staleProgram) return stalePattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const staleUpdate = expect(controller.setPattern(staleProgram)).rejects
        .toThrow(/pattern changed while the source update was compiling/);
      await commitEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseCommit.resolve();
      await staleUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(await controller.result.get()).toEqual({
        version: "winner",
        output: 50,
      });
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("returns the current winner's schema after a post-commit update race", async () => {
    const initialProgram = compiledResultNarrowingProgram(
      "string | number | boolean",
    );
    const firstProgram = compiledResultNarrowingProgram("string | number");
    const winnerProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      firstProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "post-commit-update-race-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const firstPostCommitSync = defer<void>();
    const winnerPostCommitSync = defer<void>();
    const releaseFirst = defer<void>();
    const releaseWinner = defer<void>();
    const runnerInternals = runtime.runner as unknown as {
      syncCellsForRunningPattern(
        resultCell: unknown,
        pattern: Pattern,
        inputs?: unknown,
      ): Promise<boolean>;
    };
    const originalSync = runnerInternals.syncCellsForRunningPattern.bind(
      runtime.runner,
    );
    const syncCounts = new Map<Pattern, number>();
    runnerInternals.syncCellsForRunningPattern = async (
      resultCell,
      pattern,
      inputs,
    ) => {
      const synced = await originalSync(resultCell, pattern, inputs);
      const count = (syncCounts.get(pattern) ?? 0) + 1;
      syncCounts.set(pattern, count);
      if (count === 2 && pattern === firstPattern) {
        firstPostCommitSync.resolve();
        await releaseFirst.promise;
      } else if (count === 2 && pattern === winnerPattern) {
        winnerPostCommitSync.resolve();
        await releaseWinner.promise;
      }
      return synced;
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === firstProgram) return firstPattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const firstUpdate = controller.setPattern(firstProgram);
      await firstPostCommitSync.promise;
      const winnerUpdate = controller.setPattern(winnerProgram);
      await winnerPostCommitSync.promise;

      releaseWinner.resolve();
      await winnerUpdate;
      releaseFirst.resolve();
      await firstUpdate;
      await runtime.idle();

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(
        controller.getCell().getAsNormalizedFullLink().schema,
      ).toEqual(winnerPattern.resultSchema);
      expect(await controller.result.get()).toEqual({ value: 5 });
      expect(
        validateSchemaValue(
          controller.getCell().getAsNormalizedFullLink().schema!,
          { value: "invalid-for-winner" },
        ),
      ).toMatch(/value does not match type number/);
      expect(await controller.result.get()).toEqual({ value: 5 });
    } finally {
      releaseFirst.resolve();
      releaseWinner.resolve();
      runnerInternals.syncCellsForRunningPattern = originalSync;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("syncs dependencies after a remote pattern supersedes local setup", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("local", 2),
      { space: manager.getSpace() },
    );
    const remotePattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("remote", 10),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { input: 5 },
      "remote-preparation-supersession-" + crypto.randomUUID(),
      { start: false },
    );
    const id = entityRefToString(piece.entityId);
    const session = await createSession({
      identity: signer,
      spaceName: manager.getSpaceName()!,
    });
    const remoteRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const remoteManager = new PieceManager(session, remoteRuntime);

    try {
      await remoteManager.synced();
      await remoteManager.runWithPattern(
        remotePattern,
        id,
        { input: 5 },
        { start: false },
      );
      await remoteManager.synced();
      await manager.synced();
      await piece.pull();
      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(remotePattern),
      );

      const runnerInternals = runtime.runner as unknown as {
        syncCellsForRunningPattern(
          resultCell: unknown,
          pattern: Pattern,
          inputs?: unknown,
        ): Promise<boolean>;
      };
      const originalSync = runnerInternals.syncCellsForRunningPattern.bind(
        runtime.runner,
      );
      let dependencySyncs = 0;
      runnerInternals.syncCellsForRunningPattern = async (
        resultCell,
        pattern,
        inputs,
      ) => {
        if (pattern === remotePattern) dependencySyncs++;
        return await originalSync(resultCell, pattern, inputs);
      };
      try {
        await runtime.start(piece);
      } finally {
        runnerInternals.syncCellsForRunningPattern = originalSync;
      }

      expect(dependencySyncs).toBeGreaterThan(0);
      expect(await piece.pull()).toEqual({
        version: "remote",
        output: 50,
      });
    } finally {
      await remoteRuntime.dispose();
    }
  });

  it("waits for setup to settle before setupPersistent syncs pattern metadata", async () => {
    const pattern = doublePattern();
    const patternRef = { identity: "test-pattern-identity", symbol: "default" };
    const originalSetup = manager.runtime.setup.bind(manager.runtime);
    const originalGetArtifactEntryRef = manager.runtime.patternManager
      .getArtifactEntryRef.bind(manager.runtime.patternManager);
    const originalSyncPatternByIdentity = manager.syncPatternByIdentity.bind(
      manager,
    );
    let setupResolved = false;
    let releaseSetup: (() => void) | undefined;
    const setupCalled = defer<void>();

    manager.runtime.setup = ((...args) => {
      const piece = args[3];
      return new Promise<typeof piece>((resolve) => {
        releaseSetup = () => {
          setupResolved = true;
          resolve(piece);
        };
        setupCalled.resolve();
      });
    }) as typeof manager.runtime.setup;

    const getRefStub: unknown = () => patternRef;
    manager.runtime.patternManager.getArtifactEntryRef =
      getRefStub as typeof manager.runtime.patternManager.getArtifactEntryRef;

    manager.syncPatternByIdentity = ((
      ref: { identity: string; symbol: string },
    ) => {
      expect(ref).toEqual(patternRef);
      expect(setupResolved).toBe(true);
      return Promise.resolve(pattern);
    }) as typeof manager.syncPatternByIdentity;

    try {
      const pending = manager.setupPersistent(pattern, { input: 5 });
      await setupCalled.promise;
      expect(setupResolved).toBe(false);
      if (!releaseSetup) {
        throw new Error("Expected runtime.setup to be called");
      }
      releaseSetup();
      await pending;
    } finally {
      manager.runtime.setup = originalSetup;
      manager.runtime.patternManager.getArtifactEntryRef =
        originalGetArtifactEntryRef;
      manager.syncPatternByIdentity = originalSyncPatternByIdentity;
    }
  });

  it("restarts stopped pieces when runWithPattern is called with start", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);

    await manager.stopPiece(piece);

    expect(runtime.runner.cancels.size).toBe(0);

    await manager.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);
    expect(manager.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("updates piece names when runWithPattern changes patterns", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, namedPattern("double", 2)),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    expect(controller.name()).toBe("double");
    expect(manager.getResult(piece).get()).toEqual({
      [NAME]: "double",
      output: 10,
    });

    await manager.runWithPattern(
      trustPattern(runtime, namedPattern("tenfold", 10)),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(controller.name()).toBe("tenfold");
    expect(manager.getResult(piece).get()).toEqual({
      [NAME]: "tenfold",
      output: 50,
    });
  });
});

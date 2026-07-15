import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  KeepAsCell,
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
  const attempts = version === 1 ? "" : "  attempts: number | Default<1>;";
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

  it("validates path-based input writes against the current schema", async () => {
    const piece = await manager.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(7, ["input"]);
    expect(await controller.input.get()).toEqual({ input: 7 });
    expect(await controller.result.get()).toEqual({ output: 14 });

    await expect(controller.input.set("invalid", ["input"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    await expect(controller.input.set(new Date(), ["input"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    expect(await controller.input.get()).toEqual({ input: 7 });

    await controller.result.set(99, ["output"]);
    expect(await controller.result.get()).toEqual({ output: 99 });
  });

  it("validates a union stream payload before sending exactly one event", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { $ref: "#/$defs/Event" },
        },
        required: ["slot"],
        $defs: {
          Event: {
            anyOf: [
              { type: "number", asCell: ["stream"] },
              { type: "undefined", asCell: ["stream"] },
            ],
          },
        },
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { slot: { $stream: true } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    const stream = inputCell.key("slot");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.input.set(5, ["slot"]);
      await runtime.idle();
      expect(events).toEqual([5]);

      await expect(controller.input.set("bad", ["slot"])).rejects.toThrow(
        /does not match/,
      );
      expect(events).toEqual([5]);

      const source = runtime.getCell<number>(
        manager.getSpace(),
        "stream-payload-link-" + crypto.randomUUID(),
        { type: "number" },
      );
      await runtime.editWithRetry((tx) => source.withTx(tx).set(9));
      const rawLink = source.getAsLink({
        base: inputCell.key("slot"),
        includeSchema: true,
      });
      await controller.input.set(rawLink, ["slot"]);
      await runtime.idle();
      expect(events).toHaveLength(2);

      await controller.input.set(undefined, ["slot"]);
      await runtime.idle();
      expect(events).toHaveLength(3);
      expect(Object.hasOwn(events, 2)).toBe(true);
      expect(events[2]).toBeUndefined();
      const rawAfterUndefined = inputCell.asSchema(undefined).get() as {
        slot?: unknown;
      };
      expect(
        Object.hasOwn(rawAfterUndefined, "slot") &&
          rawAfterUndefined.slot === undefined,
      ).toBe(false);
    } finally {
      removeHandler();
    }
  });

  it("accepts an opaque Cell supplied as a path value", async () => {
    const source = runtime.getCell<number>(
      manager.getSpace(),
      "opaque-input-cell-" + crypto.randomUUID(),
      { type: "number" },
    );
    await runtime.editWithRetry((tx) => source.withTx(tx).set(7));
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          handle: { type: "number", asCell: ["cell"] },
        },
        required: ["handle"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { handle: source },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(source, ["handle"]);

    expect(await controller.input.get(["handle"])).toBe(7);
  });

  it("hydrates path defaults while retaining raw explicit undefined", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              mode: { type: "string" },
              attempts: { type: "number", default: 1 },
              label: {
                type: ["string", "undefined"],
                default: "fallback",
              },
            },
            required: ["mode", "attempts", "label"],
          },
        },
        required: ["settings"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { settings: { mode: "old", attempts: 1, label: "old" } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(
      { mode: "new", label: undefined },
      ["settings"],
    );
    const settings = await controller.input.get(["settings"]) as Record<
      string,
      unknown
    >;
    expect(settings.mode).toBe("new");
    expect(settings.attempts).toBe(1);
    expect(Object.hasOwn(settings, "label")).toBe(true);
    // Typed reads intentionally project a schema default over undefined.
    expect(settings.label).toBe("fallback");
    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get() as { settings: Record<string, unknown> };
    expect(Object.hasOwn(rawInput.settings, "label")).toBe(true);
    expect(rawInput.settings.label).toBeUndefined();

    await controller.input.set("again", ["settings", "label"]);
    await controller.input.set(undefined, ["settings", "label"]);
    const explicit = await controller.input.get(["settings"]) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(explicit, "label")).toBe(true);
    expect(explicit.label).toBe("fallback");
    const rawExplicit = (await controller.input.getCell()).asSchema(undefined)
      .get() as { settings: Record<string, unknown> };
    expect(Object.hasOwn(rawExplicit.settings, "label")).toBe(true);
    expect(rawExplicit.settings.label).toBeUndefined();
  });

  it("stores explicit undefined at absent object and array paths", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { type: ["number", "undefined"] },
          label: {
            type: ["string", "undefined"],
            default: "fallback",
          },
          items: {
            type: "array",
            items: { type: ["number", "undefined"] },
          },
        },
        required: ["slot", "items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const items = new Array(1);
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { items },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set(undefined, ["slot"]);
    await controller.input.set(undefined, ["label"]);
    await controller.input.set(undefined, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get() as { slot?: unknown; label?: unknown; items: unknown[] };
    expect(Object.hasOwn(rawInput, "slot")).toBe(true);
    expect(rawInput.slot).toBeUndefined();
    expect(Object.hasOwn(rawInput, "label")).toBe(true);
    expect(rawInput.label).toBeUndefined();
    expect(Object.hasOwn(rawInput.items, 0)).toBe(true);
    expect(rawInput.items[0]).toBeUndefined();
    expect(await controller.input.get(["label"])).toBe("fallback");
  });

  it("stores explicit undefined at result object and array paths", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        slot: { type: ["number", "undefined"] },
        label: {
          type: ["string", "undefined"],
          default: "fallback",
        },
        items: {
          type: "array",
          items: { type: ["number", "undefined"] },
        },
      },
      required: ["items"],
    } as const;
    const resultItems = new Array(1);
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema,
      result: { items: resultItems },
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.result.set(undefined, ["slot"]);
    await controller.result.set(undefined, ["label"]);
    await controller.result.set(undefined, ["items", 0]);

    const rawResult = (await controller.result.getCell()).asSchema(undefined)
      .get() as { slot?: unknown; label?: unknown; items: unknown[] };
    expect(Object.hasOwn(rawResult, "slot")).toBe(true);
    expect(rawResult.slot).toBeUndefined();
    expect(Object.hasOwn(rawResult, "label")).toBe(true);
    expect(rawResult.label).toBeUndefined();
    expect(Object.hasOwn(rawResult.items, 0)).toBe(true);
    expect(rawResult.items[0]).toBeUndefined();
    expect(await controller.result.get(["label"])).toBe("fallback");
  });

  it("selects root union defaults for a path write", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "a" },
              settings: {
                type: "object",
                properties: {
                  attempts: { type: "number", default: 1 },
                },
                required: ["attempts"],
              },
            },
            required: ["kind", "settings"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "b" },
              settings: {
                type: "object",
                properties: {
                  retries: { type: "number", default: 2 },
                },
                required: ["retries"],
              },
            },
            required: ["kind", "settings"],
          },
        ],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { kind: "a", settings: { attempts: 7 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set({}, ["settings"]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({
      kind: "a",
      settings: { attempts: 1 },
    });
    expect(validateSchemaValue(pattern.argumentSchema, rawInput))
      .toBeUndefined();
    expect(await controller.input.get(["kind"])).toBe("a");

    await expect(controller.input.set("b", ["kind"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    const afterRejectedSwitch = (await controller.input.getCell()).asSchema(
      undefined,
    ).get();
    expect(afterRejectedSwitch).toEqual(rawInput);
    expect(validateSchemaValue(pattern.argumentSchema, afterRejectedSwitch))
      .toBeUndefined();
  });

  it("hydrates item-schema defaults for an array element write", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                mode: { type: "string" },
                attempts: { type: "number", default: 1 },
              },
              required: ["mode", "attempts"],
            },
          },
        },
        required: ["items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { items: [{ mode: "old", attempts: 2 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set({ mode: "new" }, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({
      items: [{ mode: "new", attempts: 1 }],
    });
  });

  it("uses a root discriminator to select array item defaults", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "a" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    attempts: { type: "number", default: 1 },
                  },
                  required: ["attempts"],
                },
              },
            },
            required: ["kind", "items"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "b" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    retries: { type: "number", default: 2 },
                  },
                  required: ["retries"],
                },
              },
            },
            required: ["kind", "items"],
          },
        ],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await manager.runPersistent(
      trustPattern(runtime, pattern),
      { kind: "a", items: [{ attempts: 7 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(manager, piece);

    await controller.input.set({}, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({ kind: "a", items: [{ attempts: 1 }] });
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
    expect(await controller.input.get()).toEqual({
      settings: { mode: "linked", attempts: 1 },
    });
    expect(await controller.result.get()).toEqual({ mode: "linked" });
  });

  it("preserves caller-supplied raw links at and below a write path", async () => {
    const sourcePattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              mode: { type: "string" },
              attempts: { type: "number" },
            },
            required: ["mode", "attempts"],
          },
        },
        required: ["settings"],
      },
      result: { settings: { mode: "linked", attempts: 3 } },
      nodes: [],
    };
    const source = await manager.runPersistent(
      trustPattern(runtime, sourcePattern),
      {},
      "raw-link-path-source-" + crypto.randomUUID(),
      { start: true },
    );
    const targetPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(2),
      { space: manager.getSpace() },
    );
    const target = await manager.runPersistent(
      targetPattern,
      { settings: { mode: "local", attempts: 1 } },
      "raw-link-path-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, target);
    await manager.link(
      entityRefToString(source.entityId),
      ["settings"],
      entityRefToString(target.entityId),
      ["settings"],
    );
    const rawBefore = (await controller.input.getCell()).getRaw() as {
      settings: unknown;
    };

    await controller.input.set(rawBefore.settings, ["settings"]);

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    await controller.input.set({ settings: rawBefore.settings });
    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({
      settings: { mode: "linked", attempts: 3 },
    });
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

    const candidate = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(2),
      { space: manager.getSpace() },
    );
    await expect(
      manager.runWithPattern(candidate, controller.id),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual({ value: 4, mode: "legacy-string" });
  });

  it("does not accept a linked stream as an optional scalar during migration", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-field-stream-conflict-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const inputCell = await controller.input.getCell();
    const stream = runtime.getCell(
      manager.getSpace(),
      "optional-field-stream-" + crypto.randomUUID(),
      { type: "number", asCell: ["stream"] },
    );
    await runtime.editWithRetry((tx) => {
      stream.withTx(tx).setRawUntyped({ $stream: true });
      inputCell.withTx(tx).key("mode").setRawUntyped(
        stream.getAsLink({
          base: inputCell,
          includeSchema: true,
          keepAsCell: KeepAsCell.OnlyStream,
        }),
      );
    });
    const rawBefore = inputCell.getRaw();
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual(rawBefore);
  });

  it("reapplies setInput against a concurrently installed pattern", async () => {
    const initialProgram = compiledMultiplierProgram("initial", 2);
    const winnerProgram = compiledMultiplierProgram("winner", 10);
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "set-input-pattern-race-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(manager, piece);
    const oldInputEntered = defer<void>();
    const releaseOldInput = defer<void>();
    const originalRunWithPattern = manager.runWithPattern;
    manager.runWithPattern = async (pattern, pieceId, inputs, options) => {
      if (
        pattern === initialPattern &&
        (inputs as { input?: number } | undefined)?.input === 7
      ) {
        oldInputEntered.resolve();
        await releaseOldInput.promise;
      }
      return await originalRunWithPattern.call(
        manager,
        pattern,
        pieceId,
        inputs,
        options,
      );
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const inputUpdate = controller.setInput({ input: 7 });
      await oldInputEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseOldInput.resolve();
      await inputUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(await controller.input.get()).toEqual({ input: 7 });
      expect(await controller.result.get()).toEqual({
        version: "winner",
        output: 70,
      });
    } finally {
      releaseOldInput.resolve();
      manager.runWithPattern = originalRunWithPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("re-resolves input schema and defaults after a commit retry", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { value: 4 },
      "piece-prop-schema-race-" + crypto.randomUUID(),
      { start: true },
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

    try {
      const inputUpdate = controller.input.set({ value: 9 });
      await commitEntered.promise;
      await controller.setPattern(compiledSchemaEvolutionProgram(2));
      releaseCommit.resolve();
      await inputUpdate;

      const currentPattern = await controller.getPattern();
      const rawInput = (await controller.input.getCell()).getRaw();
      expect(rawInput).toEqual({
        value: 9,
        retries: 0,
        options: { attempts: 1 },
      });
      expect(validateSchemaValue(currentPattern.argumentSchema, rawInput))
        .toBeUndefined();
      expect(await controller.result.get()).toEqual({
        doubled: 9,
        summary: "updated",
      });
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("re-resolves root schema defaults for a path write after retry", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(1),
      { space: manager.getSpace() },
    );
    const piece = await manager.runPersistent(
      firstPattern,
      { settings: { mode: "old" } },
      "piece-prop-path-schema-race-" + crypto.randomUUID(),
      { start: true },
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

    try {
      const inputUpdate = controller.input.set(
        { mode: "new" },
        ["settings"],
      );
      await commitEntered.promise;
      await controller.setPattern(compiledLinkedSettingsProgram(2));
      releaseCommit.resolve();
      await inputUpdate;

      const currentPattern = await controller.getPattern();
      const rawInput = (await controller.input.getCell()).getRaw();
      expect(rawInput).toEqual({
        settings: { mode: "new", attempts: 1 },
      });
      expect(validateSchemaValue(currentPattern.argumentSchema, rawInput))
        .toBeUndefined();
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
    }
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

  it("does not install an older controller mutation after a newer one", async () => {
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
      "controller-update-race-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const firstRunEntered = defer<void>();
    const releaseFirstRun = defer<void>();
    const originalRunWithPattern = manager.runWithPattern;
    manager.runWithPattern = async (
      pattern,
      pieceId,
      inputs,
      options,
    ) => {
      if (pattern === firstPattern) {
        firstRunEntered.resolve();
        await releaseFirstRun.promise;
        return piece.asSchema(firstPattern.resultSchema);
      }
      if (pattern === winnerPattern) {
        return piece.asSchema(winnerPattern.resultSchema);
      }
      return await originalRunWithPattern.call(
        manager,
        pattern,
        pieceId,
        inputs,
        options,
      );
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
      await firstRunEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseFirstRun.resolve();
      await firstUpdate;

      expect(controller.getCell().getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseFirstRun.resolve();
      manager.runWithPattern = originalRunWithPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("keeps a committed newer schema after its post-commit failure", async () => {
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
      "controller-post-commit-failure-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(manager, piece);
    const firstRunReturned = defer<void>();
    const releaseFirstRun = defer<void>();
    const originalRunWithPattern = manager.runWithPattern;
    manager.runWithPattern = async (
      pattern,
      pieceId,
      inputs,
      options,
    ) => {
      const cell = await originalRunWithPattern.call(
        manager,
        pattern,
        pieceId,
        inputs,
        options,
      );
      if (pattern === firstPattern) {
        firstRunReturned.resolve();
        await releaseFirstRun.promise;
      } else if (pattern === winnerPattern) {
        throw new Error("injected post-commit failure");
      }
      return cell;
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
      await firstRunReturned.promise;
      await expect(controller.setPattern(winnerProgram)).rejects.toThrow(
        /injected post-commit failure/,
      );
      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );

      releaseFirstRun.resolve();
      await firstUpdate;

      expect(controller.getCell().getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseFirstRun.resolve();
      manager.runWithPattern = originalRunWithPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("rechecks the durable identity after loading the winner's schema", async () => {
    const initialPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string | number | boolean"),
      { space: manager.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string"),
      { space: manager.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("number"),
      { space: manager.getSpace() },
    );
    const firstRef = runtime.patternManager.getArtifactEntryRef(firstPattern);
    const winnerRef = runtime.patternManager.getArtifactEntryRef(winnerPattern);
    if (!firstRef || !winnerRef) {
      throw new Error("missing compiled pattern ref");
    }

    const piece = await manager.runPersistent(
      initialPattern,
      { input: 5 },
      "schema-load-race-" + crypto.randomUUID(),
      { start: false },
    );
    const loadEntered = defer<void>();
    const releaseLoad = defer<void>();
    const originalLoad = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    let heldFirstLoad = false;
    runtime.patternManager.loadPatternByIdentity = async (
      identity,
      symbol,
      space,
    ) => {
      const current = getPatternIdentityRef(piece);
      if (
        !heldFirstLoad && identity === firstRef.identity &&
        current?.identity === firstRef.identity &&
        current.symbol === firstRef.symbol
      ) {
        heldFirstLoad = true;
        loadEntered.resolve();
        await releaseLoad.promise;
      }
      return await originalLoad(identity, symbol, space);
    };

    try {
      const firstRun = runtime.runSynced(piece, firstPattern, { input: 5 });
      await loadEntered.promise;

      const winnerCell = await runtime.runSynced(
        piece,
        winnerPattern,
        { input: 5 },
      );
      expect(getPatternIdentityRef(piece)).toEqual(winnerRef);
      expect(winnerCell.getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );

      releaseLoad.resolve();
      const firstCell = await firstRun;
      expect(getPatternIdentityRef(piece)).toEqual(winnerRef);
      expect(firstCell.getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseLoad.resolve();
      runtime.patternManager.loadPatternByIdentity = originalLoad;
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

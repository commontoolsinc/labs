import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FileSystemProgramResolver,
  InMemoryProgram,
} from "@commonfabric/js-compiler";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { CompiledModuleGraph } from "../src/sandbox/module-record-compiler.ts";

const signer = await Identity.fromPassphrase("test operator");

// All authored modules' compiled CommonJS bodies, joined — the ESM analogue of
// the old single-bundle `jsScript.js` for transformer-output assertions.
const joinedBodies = (graph: CompiledModuleGraph): string =>
  [...graph.compiledBodies.values()].join("\n");

describe("Engine.compileToRecordGraph()", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compiles a simple program to a verified record graph", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
      ],
    };

    const result = await engine.compileToRecordGraph(program);

    expect(result.id).toBeDefined();
    expect(result.mainSpecifier.startsWith("cf:module/")).toBe(true);
    expect(result.graph.records.has(result.mainSpecifier)).toBe(true);
    expect(result.graph.compiledBodies.size).toBeGreaterThan(0);
    expect(joinedBodies(result.graph).length).toBeGreaterThan(0);
  });

  it("compiles a multi-file program", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/utils.ts",
          contents: "export const double = (x: number) => x * 2;",
        },
        {
          name: "/main.tsx",
          contents: [
            "import { double } from './utils.ts';",
            "export default function run() {",
            "  return double(21);",
            "}",
          ].join("\n"),
        },
      ],
    };

    const result = await engine.compileToRecordGraph(program);

    expect(joinedBodies(result.graph)).toContain("double");
  });

  it("accepts default-import normalization in compiled module bodies", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/dep.ts",
          contents: "const value = 21; export default value;",
        },
        {
          name: "/main.ts",
          contents: "import value from './dep.ts'; export default value;",
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__importDefault");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBe(21);
  });

  it("accepts top-level async function declarations in SES modules", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export async function load() {",
            "  return 21;",
            "}",
            "export default load;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(await main?.default()).toBe(21);
  });

  it("accepts module-scope handlers that capture async function declarations", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { handler, type Writable } from "commonfabric";',
            "const trigger = handler<unknown, { value: Writable<number> }>(",
            "  async (_event, state) => {",
            "    state.value.set(await process(state.value.get()));",
            "  },",
            ");",
            "export async function process(value: number): Promise<number> {",
            "  return value + 1;",
            "}",
            "export default trigger;",
          ].join("\n"),
        },
      ],
    };

    const { graph } = await engine.compileToRecordGraph(program);

    expect(joinedBodies(graph)).toContain("process");
  });

  it("produces per-module source maps", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 'hello';",
        },
      ],
    };

    const { graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );

    expect(graph.moduleSourceMaps.size).toBeGreaterThan(0);
    expect(graph.moduleSourceMaps.get(mainSpecifier)).toBeDefined();
  });

  it("produces deterministic output for the same input", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 123;",
        },
      ],
    };

    const first = await engine.compileToRecordGraph(program);
    const second = await engine.compileToRecordGraph(program);

    expect(first.id).toBe(second.id);
    expect(first.mainSpecifier).toBe(second.mainSpecifier);
    expect(joinedBodies(first.graph)).toBe(joinedBodies(second.graph));
  });

  it("resolves programs when host fetch is mocked before SES init", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    try {
      const program = await engine.resolve(
        new InMemoryProgram("/main.ts", {
          "/main.ts": "export default 1;",
        }),
      );

      expect(program.main).toBe("/main.ts");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on compilation errors", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            "import { nonExistent } from './missing.ts'; export default nonExistent;",
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow();
  });

  it("emits __cf_data for CTS top-level data and evaluates it at runtime", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'const lookup = (() => ({ open: "Open" }))();',
            "export default lookup.open;",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );

    expect(joinedBodies(graph)).toContain("__cf_data");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBe("Open");
  });

  it("preserves explicit SES-safe snapshot helpers in CTS modules", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { nonPrivateRandom, safeDateNow } from "commonfabric";',
            "const startedAt = safeDateNow();",
            "const seed = nonPrivateRandom();",
            "export default function probe() {",
            "  return {",
            "    startedAt,",
            "    seed,",
            "    now: safeDateNow(),",
            "    random: nonPrivateRandom(),",
            "  };",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const bodies = joinedBodies(graph);
    expect(bodies).toContain("safeDateNow");
    expect(bodies).toContain("nonPrivateRandom");
    expect(bodies).not.toContain("__cfHelpers.safeDateNow");
    expect(bodies).not.toContain("__cfHelpers.nonPrivateRandom");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    const result = main?.default();

    expect(typeof result?.startedAt).toBe("number");
    expect(typeof result?.now).toBe("number");
    expect(typeof result?.seed).toBe("number");
    expect(typeof result?.random).toBe("number");
  });
});

describe("Engine.evaluateRecordGraph()", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("evaluates compiled modules and returns exports", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42; export const name = 'test';",
        },
      ],
    };

    const result = await engine.compileAndEvaluateModules(program);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]).toBe(42);
    expect(result.exportMap).toBeDefined();
  });

  it("does not initialize the TypeScript compiler when evaluating a precompiled graph", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const evaluateOnlyEngine = new class extends Engine {
      override initializeCompiler(): never {
        throw new Error("compiler initialized during evaluate");
      }
    }(runtime);

    try {
      const result = evaluateOnlyEngine.evaluateRecordGraph(
        id,
        graph,
        mainSpecifier,
        program.files,
      );
      expect(result.main!["default"]).toBe(42);
    } finally {
      evaluateOnlyEngine.dispose();
    }
  });

  it("correctly maps exports from multi-file programs", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/utils.ts",
          contents:
            "export const double = (x: number) => x * 2; export const triple = (x: number) => x * 3;",
        },
        {
          name: "/main.tsx",
          contents: [
            "import { double } from './utils.ts';",
            "export default function run() {",
            "  return double(21);",
            "}",
          ].join("\n"),
        },
      ],
    };

    const result = await engine.compileAndEvaluateModules(program);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]()).toBe(42);
    expect(result.exportMap).toBeDefined();

    // exportMap should include exports from source files
    // (also includes the injected /index.ts re-export entry)
    const files = Object.keys(result.exportMap!);
    expect(files.length).toBeGreaterThanOrEqual(2);

    // Find the utils entry — keys are normalized authored paths.
    const utilsKey = files.find((f) => f.includes("utils"));
    expect(utilsKey).toBeDefined();
    const utilExports = result.exportMap![utilsKey!];
    expect(typeof utilExports["double"]).toBe("function");
    expect(typeof utilExports["triple"]).toBe("function");
  });

  it("serializes verified javascript modules by stable $implRef", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const doubled = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: doubled(value) }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    runtime.patternManager.associatePatternProgram(
      main!.default as never,
      program,
    );
    const pattern = main!.default as { nodes: Array<{ module: unknown }> };
    const serialized = JSON.parse(
      JSON.stringify(
        pattern,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );

    const module = serialized.nodes[0].module as {
      $implRef?: { identity: string; symbol: string };
      implementationRef?: string;
      implementation?: string;
    };
    // Since the flip the serialized identity is the content-addressed
    // `$implRef`; the legacy `implementationRef` is runtime-only and the body
    // is omitted because this engine's implementation index resolves the ref.
    expect(module.$implRef).toBeDefined();
    expect(typeof module.$implRef!.identity).toBe("string");
    expect(typeof module.$implRef!.symbol).toBe("string");
    expect("implementationRef" in module).toBe(false);
    expect(module.implementation).toBeUndefined();
    expect(
      engine.getVerifiedImplementation(
        module.$implRef!.identity,
        module.$implRef!.symbol,
      ),
    ).toBeDefined();
  });

  it("keeps the serialized identity stable across separate load sessions of the same source", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const doubled = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: doubled(value) }));",
          ].join("\n"),
        },
      ],
    };

    const first = await engine.compileAndEvaluateModules(program);
    const second = await engine.compileAndEvaluateModules(program);

    const firstSerialized = JSON.parse(
      JSON.stringify(
        first.main!.default,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );
    const secondSerialized = JSON.parse(
      JSON.stringify(
        second.main!.default,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );

    // Content-addressed `$implRef` is byte-derived, so two loads of identical
    // source serialize the identical ref.
    expect(firstSerialized.nodes[0].module.$implRef).toBeDefined();
    expect(firstSerialized.nodes[0].module.$implRef).toEqual(
      secondSerialized.nodes[0].module.$implRef,
    );
  });

  it("rejects authored local-module namespace imports in SES mode", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/helper.ts",
          contents: "export const value = 1;",
        },
        {
          name: "/main.ts",
          contents: [
            "import * as helper from './helper.ts';",
            "export default function probe() {",
            "  try {",
            "    (helper as typeof helper & { state?: number }).state = 1;",
            '    return "allowed";',
            "  } catch (error) {",
            "    return (error as Error).name;",
            "  }",
            "}",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("allows top-level schema() without CTS because it is a runtime helper", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { schema } from "commonfabric";',
            "const model = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            '  required: ["count"],',
            "});",
            "export default model;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["default"]).toEqual({
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    });
  });

  it("allows explicit __cf_data() snapshots without CTS", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { __cf_data, nonPrivateRandom, safeDateNow } from "commonfabric";',
            "const startedAt = safeDateNow();",
            "const seed = nonPrivateRandom();",
            "const snapshot = __cf_data({ startedAt, seed });",
            "export default snapshot;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(typeof main?.default?.startedAt).toBe("number");
    expect(typeof main?.default?.seed).toBe("number");
  });

  it("rejects raw mutable top-level exports without __cf_data()", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "/// <cf-disable-transform />",
            "export default {",
            "  nested: { count: 1 },",
            "};",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow();
  });

  it("rejects raw top-level helper calls without __cf_data()", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "/// <cf-disable-transform />",
            "function build() {",
            "  return { count: 1 };",
            "}",
            "export default build();",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Top-level call results must be wrapped in __cf_data() in SES mode",
    );
  });

  it("rejects default-exported functions returning builder call results", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, type FactoryInput } from "commonfabric";',
            "const Wrapper = pattern(() => ({ value: 1 }));",
            "function ChildManager(input: FactoryInput<{}>) {",
            "  input;",
            "  return Wrapper({});",
            "}",
            "export default ChildManager;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "pattern() is not allowed inside standalone functions",
    );
  });

  it("rejects nested and branched default-exported builder call results", async () => {
    const bodyVariants = [
      [
        "  return true",
        "    ? Wrapper({})",
        "    : null;",
      ],
      [
        "  return {",
        "    child: Wrapper({}),",
        "  };",
      ],
    ];

    for (const body of bodyVariants) {
      const program: RuntimeProgram = {
        main: "/main.ts",
        files: [
          {
            name: "/main.ts",
            contents: [
              'import { pattern, type FactoryInput } from "commonfabric";',
              "const Wrapper = pattern(() => ({ value: 1 }));",
              "function ChildManager(input: FactoryInput<{}>) {",
              "  input;",
              ...body,
              "}",
              "export default ChildManager;",
            ].join("\n"),
          },
        ],
      };

      await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
        "pattern() is not allowed inside standalone functions",
      );
    }
  });

  it("rejects default-exported trusted runtime helper references", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Default exports must be trusted builders, direct functions, verified data, or import re-exports",
    );
  });

  it("rejects default-exported aliases of trusted runtime helpers", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern } from "commonfabric";',
            "const rawPattern = pattern;",
            "export default rawPattern;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Default exports must be trusted builders, direct functions, verified data, or import re-exports",
    );
  });

  it("allows default-exported functions that call plain local helpers", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "function double(value: number) {",
            "  return value * 2;",
            "}",
            "export default function run() {",
            "  return double(21);",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default()).toBe(42);
  });

  it("compiles default export calls that evaluate to primitive snapshots through __cf_data", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/math.ts",
          contents: [
            "export function pow(x: number): number {",
            "  return x * x;",
            "}",
          ].join("\n"),
        },
        {
          name: "/main.ts",
          contents: [
            'import { pow } from "./math.ts";',
            "export default pow(5);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cfHelpers.__cf_data(");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBe(25);
  });

  it("compiles mixed CTS and non-CTS files with snapshot helpers through __cfHelpers", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/helpers.ts",
          contents: [
            'import { lift } from "commonfabric";',
            "export const increment = lift((value: number) => value + 1);",
          ].join("\n"),
        },
        {
          name: "/math.ts",
          contents: [
            "export function pow(x: number): number {",
            "  return x * x;",
            "}",
          ].join("\n"),
        },
        {
          name: "/main.ts",
          contents: [
            'import "./helpers.ts";',
            'import { pow } from "./math.ts";',
            "export default pow(5);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cfHelpers.__cf_data(");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBe(25);
  });

  it("throws when handler() relies on CTS inference without CTS", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "/// <cf-disable-transform />",
            'import { handler } from "commonfabric";',
            "export default handler((_event: { count: number }, state: { count: number }) => {",
            "  state.count = state.count + 1;",
            "});",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileAndEvaluateModules(program)).rejects.toThrow(
      "Handler requires schemas or CTS transformer",
    );
  });

  it("keeps handler implementation refs bound to the handler callback", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { handler, pattern, schema } from "commonfabric";',
            'import "commonfabric/schema";',
            "const model = schema({",
            '  type: "object",',
            "  properties: {",
            '    value: { type: "number", default: 0, asCell: ["cell"] },',
            "  },",
            "  default: { value: 0 },",
            "});",
            "const increment = handler({}, model, (_, state) => {",
            "  state.value.set(state.value.get() + 1);",
            "});",
            "export { increment };",
            "export default pattern(",
            "  (cell) => ({",
            "    increment: increment(cell),",
            "    value: cell.value,",
            "  }),",
            "  model,",
            "  model,",
            ");",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    const handlerNode = main?.default?.nodes?.find((node: {
      module?: { wrapper?: string };
    }) => node.module?.wrapper === "handler");
    const module = handlerNode?.module as {
      implementation?: unknown;
    } | undefined;

    expect(typeof module?.implementation).toBe("function");
    // The handler callback's identity facts ride its provenance, and the
    // engine's implementation index resolves the {identity, symbol} back to
    // the SAME live function — the binding the legacy ref index used to pin.
    const provenance = getVerifiedProvenance(
      module!.implementation as (...args: unknown[]) => unknown,
    );
    expect(provenance?.symbol).toBeDefined();
    expect(
      engine.getVerifiedImplementation(
        provenance!.identity,
        provenance!.symbol!,
      ),
    ).toBe(module?.implementation);
  });
});

describe("Engine in SES mode", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("evaluates safe programs inside SES compartments", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: "export default 42;",
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBe(42);
  });

  it("allows direct top-level builder definitions with schema constants", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, schema } from "commonfabric";',
            "const model = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            '  required: ["count"],',
            "});",
            "export default pattern<{ count: number }>(({ count }) => ({ count }), model, model);",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main?.default).toBeDefined();
    expect(main?.default.nodes).toBeDefined();
  });

  it("allows CTS-wrapped top-level data to be captured by builder callbacks", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            'const labels = (() => ({ open: "Open" }))();',
            "export default lift(() => labels.open);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBeDefined();
  });

  it("allows CTS-wrapped accessor-backed data snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            "const lookup = {",
            '  get open() { return "Open"; },',
            "};",
            "export default lift(() => lookup.open);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBeDefined();
  });

  it("rejects proxy-backed top-level snapshots while Proxy stays disabled", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            'const lookup = new Proxy({ open: "Open" }, {',
            "  get(target, key) {",
            '    return key === "open" ? "Open" : Reflect.get(target, key);',
            "  },",
            "});",
            "export default lift(() => lookup.open);",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      /Mutable top-level data must be wrapped in __cf_data|Only verified plain data|Only trusted builder calls/,
    );
  });

  it("allows CTS-wrapped symbol-keyed data snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            "const lookup = (() => {",
            '  const tag = Symbol("open");',
            '  return { [tag]: "Open" };',
            "})();",
            "export default lift(() => Object.getOwnPropertySymbols(lookup).length);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBeDefined();
  });

  it("compiles JSX fragments without helper mutation escape hatches", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern(() => ({",
            "  ui: <>Hello</>,",
            "}));",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const bodies = joinedBodies(graph);

    expect(bodies).toContain("__cfHelpers.h.fragment");
    expect(bodies).not.toContain(".fragment =");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBeDefined();
  });

  it("allows CTS-wrapped local helper calls for inert top-level data", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { safeDateNow } from "commonfabric";',
            "function buildYears() {",
            "  const currentYear = new Date(safeDateNow()).getFullYear();",
            "  const years: string[] = [];",
            "  for (let year = currentYear; year >= currentYear - 2; year--) {",
            "    years.push(String(year));",
            "  }",
            "  return years;",
            "}",
            "const years = buildYears();",
            "export default years;",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data(buildYears())");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toHaveLength(3);
    expect(typeof main?.default?.[0]).toBe("string");
  });

  it("allows CTS-wrapped Object.fromEntries() top-level snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'const scopeMap = { gmail: "gmail.readonly" } as const;',
            "const scopes = Object.fromEntries(",
            "  Object.entries(scopeMap).map(([key, value]) => [key, { value }]),",
            ");",
            "export default scopes;",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data(Object.fromEntries(");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toEqual({
      gmail: { value: "gmail.readonly" },
    });
  });

  it("allows CTS-wrapped RegExp top-level snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "const matcher = /^[a-z]+$/;",
            "export default matcher;",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data(/^[a-z]+$/)");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBeInstanceOf(RegExp);
    expect(main?.default?.test("hello")).toBe(true);
  });

  it("allows top-level template literal snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "const layout = `# Aisle 1",
            "Milk",
            "Eggs`;",
            "export default layout;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toContain("# Aisle 1");
    expect(main?.default).toContain("Eggs");
  });

  it("wraps imported helper modules inside CTS graphs", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { TEMPLATE_REGISTRY } from "./template-registry.ts";',
            'export { INTERNAL_MODULE_TYPES } from "./schema-utils-pure.ts";',
            "export default TEMPLATE_REGISTRY.person.label;",
          ].join("\n"),
        },
        {
          name: "/template-registry.ts",
          contents: [
            "export const TEMPLATE_REGISTRY = {",
            '  person: { label: "Person" },',
            "};",
          ].join("\n"),
        },
        {
          name: "/schema-utils-pure.ts",
          contents:
            'export const INTERNAL_MODULE_TYPES = new Set(["type-picker"]);',
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const bodies = joinedBodies(graph);
    expect(bodies).toMatch(
      /exports\.TEMPLATE_REGISTRY = commonfabric_\d+\.__cfHelpers\.__cf_data\(\{/,
    );
    expect(bodies).toMatch(
      /exports\.INTERNAL_MODULE_TYPES = commonfabric_\d+\.__cfHelpers\.__cf_data\(new Set\(\["type-picker"\]\)\);/,
    );

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(main?.default).toBe("Person");
  });

  it("compiles the self-improving classifier pattern", async () => {
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    const sourcePath = new URL(
      "../../patterns/self-improving-classifier.tsx",
      import.meta.url,
    ).pathname;
    const program = await engine.resolve(
      new FileSystemProgramResolver(sourcePath, repoRoot),
    );

    const { graph } = await engine.compileToRecordGraph(program);
    expect(joinedBodies(graph).length).toBeGreaterThan(0);
  });

  it("rejects top-level mutable bindings", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "let counter = 0;",
            "export default function next() {",
            "  counter += 1;",
            "  return counter;",
            "}",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("rejects top-level IIFEs that try to hide mutable state", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "/// <cf-disable-transform />",
            "const state = (() => ({ count: 0 }))();",
            "export default 42;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Only trusted builder calls",
    );
  });

  it("rejects top-level patternTool() bindings in SES mode", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, patternTool } from "commonfabric";',
            "export default patternTool(pattern(() => ({ ok: true })));",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Only trusted builder calls",
    );
  });

  it("compiles and evaluates a patternTool whose pattern is hoisted to module scope", async () => {
    // CT-1655: patternTool's `pattern(...)` argument is hoisted to a module-scope
    // const by BuilderCallHoistingTransformer. Compile + evaluate end-to-end (not
    // just transformer goldens) to confirm the hoisted pattern doesn't trip a
    // module-load error and the tool survives. The pattern returns a plain-data
    // object (as patternTool patterns do); `count` is supplied per-call.
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, patternTool } from "commonfabric";',
            "export default pattern(() => {",
            "  const tool = patternTool(",
            "    pattern(({ count }: { count: number }) => ({ doubled: count * 2 })),",
            "  );",
            "  return { tool };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBeDefined();
  });

  it("allows trusted-builder callbacks that capture top-level schema snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift, schema } from "commonfabric";',
            "const state = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            "});",
            "export default lift(() => state.type);",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBeDefined();
  });

  it("allows trusted-builder callbacks that capture top-level schema snapshots via shorthand properties", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift, schema } from "commonfabric";',
            "const state = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            "});",
            "export default lift(() => ({ state }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBeDefined();
  });

  it("rejects untransformed toSchema() before evaluation in SES mode", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "/// <cf-disable-transform />",
            'import { toSchema } from "commonfabric";',
            "export default toSchema<{ count: number }>({",
            "  default: { count: 0 },",
            "});",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Only trusted builder calls",
    );
  });

  it("hardens direct top-level functions against hidden mutable state", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "function next() {",
            "  const self = next as typeof next & { count?: number };",
            "  self.count = (self.count ?? 0) + 1;",
            "  return self.count;",
            "}",
            "export default next;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect(() => (main?.default as () => number)()).toThrow();
  });

  it("rejects top-level fragment mutation escape hatches", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "function counter() {",
            "  const self = counter as typeof counter & { fragment?: { count: number } };",
            "  self.fragment!.count += 1;",
            "  return self.fragment!.count;",
            "}",
            "counter.fragment = { count: 0 };",
            "export default counter;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow();
  });

  it("hardens trusted builder callbacks against hidden mutable state", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commonfabric";',
            "export default lift(function step() {",
            "  const self = step as typeof step & { count?: number };",
            "  self.count = (self.count ?? 0) + 1;",
            "  return self.count;",
            "});",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    const implementation = (main?.default as {
      implementation: () => number;
    }).implementation;

    expect(() => implementation()).toThrow();
  });

  it("reconstructs stringified functions through cached callback creators", () => {
    const next = engine.getInvocation("function next(x) { return x + 1; }") as (
      input: number,
    ) => number;

    expect(next(1)).toBe(2);
  });

  it("accepts function-producing callback expressions with fresh state", () => {
    const next = engine.getInvocation(
      "(() => { let leaked = 0; return () => ++leaked; })()",
    ) as () => number;

    expect(next()).toBe(1);
    expect(next()).toBe(1);
  });

  it("rejects non-function callback source when invoked", () => {
    const notFn = engine.getInvocation("42") as () => unknown;

    expect(() => notFn()).toThrow();
  });

  it("reconstructs callbacks with embedded quotes safely", () => {
    const probe = engine.getInvocation(
      `() => 'single "double" \`template\` \\\\ slash'`,
    ) as () => string;

    expect(probe()).toBe(`single "double" \`template\` \\ slash`);
  });

  it("rehydrates stringified functions in the smaller callback compartment", () => {
    const probe = engine.getInvocation(
      "function probe() { return typeof globalThis.RUNTIME_ENGINE_CONSOLE_HOOK; }",
    ) as () => string;

    expect(probe()).toBe("undefined");
  });

  it("owns callback creator caches on the engine runtime and clears them on dispose", () => {
    const next = engine.getInvocation("function next(x) { return x + 1; }") as (
      input: number,
    ) => number;

    expect(next(1)).toBe(2);
    expect(
      (engine as unknown as {
        sesRuntime: {
          callbackEvaluator: {
            callbackCreatorCache: Map<string, () => unknown>;
          };
        };
      }).sesRuntime.callbackEvaluator.callbackCreatorCache.size,
    ).toBe(1);

    engine.dispose();

    expect(
      (engine as unknown as {
        sesRuntime?: {
          callbackEvaluator: {
            callbackCreatorCache: Map<string, () => unknown>;
          };
        };
      }).sesRuntime?.callbackEvaluator.callbackCreatorCache.size ?? 0,
    ).toBe(0);
  });
});

describe("Engine compile + evaluate", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("compile+evaluate works with pattern source", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const double = lift<number>((x) => x * 2);",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  return { result: double(value) };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const result = await engine.compileAndEvaluateModules(program);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]).toBeDefined();
  });

  it("compile returns a record graph, evaluate executes it", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 'hello';",
        },
      ],
    };

    // compileToRecordGraph() should not execute the modules
    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(graph.compiledBodies.size).toBeGreaterThan(0);

    // evaluateRecordGraph() should execute them
    const result = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program.files,
    );
    expect(result.main!["default"]).toBe("hello");
  });

  it("compile+evaluate returns the default export pattern", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["default"]).toBeDefined();
    expect(main!["default"].nodes).toBeDefined();
  });

  it("evaluate returns undefined for missing named export", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      mainExport: "nonExistent",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["nonExistent"]).toBeUndefined();
  });

  it("compile+evaluate retrieves named export", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      mainExport: "myPattern",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export const myPattern = pattern<{ x: number }>(({ x }) => ({ x }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["myPattern"]).toBeDefined();
    expect(main!["myPattern"].nodes).toBeDefined();
  });
});

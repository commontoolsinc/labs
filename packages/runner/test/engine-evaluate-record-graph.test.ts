import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  getVerifiedProvenance,
  joinedBodies,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";
import { validateCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
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

  it("carries compiler-verified policy manifests outside module exports", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
        `,
      }],
    };

    const compiled = await engine.compileToRecordGraph(program);
    const module = compiled.modules[0]!;
    const artifact = validateCfcPolicyArtifactManifest(
      module.policyManifests?.[0],
    );

    expect(artifact.manifest.moduleIdentity).toBe(module.identity);
    expect(artifact.manifest.symbol).toBe("rules");
    expect(module.js).not.toContain(artifact.policyDigest);

    const checked = await engine.typeCheckBatch([program]);
    expect(checked.patternCount).toBe(1);
    expect(checked.diagnostics).toEqual([]);

    const recovered = await engine.compileResolvedToRecordGraph(
      program.files,
      program.main,
    );
    expect(recovered.modules[0]?.policyManifests).toHaveLength(1);
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
            'import { __cf_data } from "commonfabric";',
            "const startedAt = 1_700_000_000_000;",
            "const seed = 0.5;",
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

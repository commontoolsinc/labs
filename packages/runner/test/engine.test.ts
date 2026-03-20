import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { moduleToJSON } from "../src/builder/json-utils.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Engine.compile()", () => {
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

  it("compiles a simple program to JsScript", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { lift } from 'commontools';",
            "const doubled = lift((value: number) => value * 2);",
            "export default doubled;",
          ].join("\n"),
        },
      ],
    };

    const result = await engine.compile(program);

    expect(result.jsScript).toBeDefined();
    expect(result.jsScript.js).toBeDefined();
    expect(typeof result.jsScript.js).toBe("string");
    expect(result.jsScript.js.length).toBeGreaterThan(0);
    expect(result.id).toBeDefined();
    expect(result.jsScript.js).toContain("__ctHelpers.__ct_");
  });

  it("compiles a multi-file program", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/utils.ts",
          contents: [
            "/// <cts-enable />",
            "export const double = (x: number) => x * 2;",
            "export const answer = 42;",
          ].join("\n"),
        },
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { answer } from './utils.ts';",
            "export default answer;",
          ].join("\n"),
        },
      ],
    };

    const result = await engine.compile(program);

    expect(result.jsScript).toBeDefined();
    expect(result.jsScript.js).toContain("double");
  });

  it("produces a source map", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 'hello';",
        },
      ],
    };

    const { jsScript } = await engine.compile(program);

    expect(jsScript.sourceMap).toBeDefined();
    expect(jsScript.filename).toBeDefined();
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

    const first = await engine.compile(program);
    const second = await engine.compile(program);

    expect(first.jsScript.js).toBe(second.jsScript.js);
    expect(first.id).toBe(second.id);
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

    await expect(engine.compile(program)).rejects.toThrow();
  });
});

describe("Engine.evaluate()", () => {
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

  it("evaluates compiled JS and returns exports", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42; export const name = 'test';",
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const result = await engine.evaluate(id, jsScript, program.files);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]).toBe(42);
    expect(result.exportMap).toBeDefined();
  });

  it("correctly maps exports from multi-file programs", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/utils.ts",
          contents: [
            "/// <cts-enable />",
            "export const double = (x: number) => x * 2;",
            "export const triple = (x: number) => x * 3;",
            "export const answer = 42;",
          ].join("\n"),
        },
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { answer } from './utils.ts';",
            "export default answer;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const result = await engine.evaluate(id, jsScript, program.files);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]).toBe(42);
    expect(result.exportMap).toBeDefined();

    // exportMap should include exports from source files
    // (also includes the injected /index.ts re-export entry)
    const files = Object.keys(result.exportMap!);
    expect(files.length).toBeGreaterThanOrEqual(2);

    // Find the utils entry — key has the /${id} prefix stripped
    const utilsKey = files.find((f) => f.includes("utils"));
    expect(utilsKey).toBeDefined();
    const utilExports = result.exportMap![utilsKey!];
    expect(typeof utilExports["double"]).toBe("function");
    expect(typeof utilExports["triple"]).toBe("function");
  });

  it("reuses one compartment for repeated evaluation of the same loaded pattern while isolating separate loads", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { pattern, lift } from 'commontools';",
            "const doubled = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: doubled(value) }));",
          ].join("\n"),
        },
      ],
    };

    const compiled = await engine.compile(program);
    await engine.evaluate(compiled.id, compiled.jsScript, program.files);
    expect(engine.getSESCompartmentCount()).toBe(1);

    await engine.evaluate(compiled.id, compiled.jsScript, program.files);
    expect(engine.getSESCompartmentCount()).toBe(1);

    const secondCompiled = await engine.compile(program);
    await engine.evaluate(
      secondCompiled.id,
      secondCompiled.jsScript,
      program.files,
    );
    expect(engine.getSESCompartmentCount()).toBe(2);
  });

  it("rebinds verified implementation refs after JSON round-trip", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { pattern, lift } from 'commontools';",
            "const doubled = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: doubled(value) }));",
          ].join("\n"),
        },
      ],
    };

    const compiled = await engine.compile(program);
    const { main } = await engine.evaluate(
      compiled.id,
      compiled.jsScript,
      program.files,
    );
    const patternId = runtime.patternManager.registerPattern(
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

    const module = serialized.nodes[0].module as Parameters<
      typeof moduleToJSON
    >[0];
    expect(typeof module.implementationRef).toBe("string");
    expect(engine.getVerifiedFunction(module.implementationRef!, patternId))
      .toBeDefined();
  });

  it("resolves stable implementation refs through the pattern association", async () => {
    const programA: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { pattern, lift } from 'commontools';",
            "const BASE = 1;",
            "const derived = lift((value: number) => value + BASE);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: derived(value) }));",
          ].join("\n"),
        },
      ],
    };
    const programB: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { pattern, lift } from 'commontools';",
            "const BASE = 10;",
            "const derived = lift((value: number) => value + BASE);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: derived(value) }));",
          ].join("\n"),
        },
      ],
    };

    const firstCompiled = await engine.compile(programA);
    const firstEvaluation = await engine.evaluate(
      firstCompiled.id,
      firstCompiled.jsScript,
      programA.files,
    );
    const firstPatternId = runtime.patternManager.registerPattern(
      firstEvaluation.main!.default as never,
      programA,
    );
    const firstRef = JSON.parse(
      JSON.stringify(
        firstEvaluation.main!.default,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    ).nodes[0].module.implementationRef as string;

    const secondCompiled = await engine.compile(programB);
    const secondEvaluation = await engine.evaluate(
      secondCompiled.id,
      secondCompiled.jsScript,
      programB.files,
    );
    const secondPatternId = runtime.patternManager.registerPattern(
      secondEvaluation.main!.default as never,
      programB,
    );
    const secondRef = JSON.parse(
      JSON.stringify(
        secondEvaluation.main!.default,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    ).nodes[0].module.implementationRef as string;

    const firstFn = engine.getVerifiedFunction(
      firstRef,
      firstPatternId,
    ) as ((value: number) => number) | undefined;
    const secondFn = engine.getVerifiedFunction(
      secondRef,
      secondPatternId,
    ) as ((value: number) => number) | undefined;

    expect(firstRef).not.toBe(secondRef);
    expect(firstFn).toBeDefined();
    expect(secondFn).toBeDefined();
    expect(firstFn).not.toBe(secondFn);
    expect(firstFn!(1)).toBe(2);
    expect(secondFn!(1)).toBe(11);
  });

  it("serialized implementationRef is stable across separate load sessions of the same source", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { pattern, lift } from 'commontools';",
            "const doubled = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: doubled(value) }));",
          ].join("\n"),
        },
      ],
    };

    // Two separate compile calls produce distinct JsScript objects with
    // distinct evaluationIds, simulating separate load sessions.
    const firstCompiled = await engine.compile(program);
    const secondCompiled = await engine.compile(program);

    const first = await engine.evaluate(
      firstCompiled.id,
      firstCompiled.jsScript,
      program.files,
    );
    const firstPattern = first.main!.default as {
      nodes: Array<{ module: unknown }>;
    };
    const firstSerialized = JSON.parse(
      JSON.stringify(
        firstPattern,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );
    const firstModuleRef =
      (firstSerialized.nodes[0].module as { implementationRef?: string })
        .implementationRef;

    const second = await engine.evaluate(
      secondCompiled.id,
      secondCompiled.jsScript,
      program.files,
    );
    const secondPattern = second.main!.default as {
      nodes: Array<{ module: unknown }>;
    };
    const secondSerialized = JSON.parse(
      JSON.stringify(
        secondPattern,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );
    const secondModuleRef =
      (secondSerialized.nodes[0].module as { implementationRef?: string })
        .implementationRef;

    const firstPatternId = runtime.patternManager.registerPattern(
      first.main!.default as never,
      program,
    );
    const secondPatternId = runtime.patternManager.registerPattern(
      second.main!.default as never,
      program,
    );

    // Serialized refs must be stable (same source -> same ref, no session scoping)
    expect(firstModuleRef).toBeDefined();
    expect(secondModuleRef).toBeDefined();
    expect(firstModuleRef).toBe(secondModuleRef);

    // Both refs must be resolvable in the verified function index
    expect(engine.getVerifiedFunction(firstModuleRef!, firstPatternId))
      .toBeDefined();
    expect(engine.getVerifiedFunction(secondModuleRef!, secondPatternId))
      .toBeDefined();
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
            "/// <cts-enable />",
            "import { pattern, lift } from 'commontools';",
            "const double = lift<number>((x) => x * 2);",
            "const mainPattern = pattern<{ value: number }>(({ value }) => {",
            "  return { result: double(value) };",
            "});",
            "export default mainPattern;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const result = await engine.evaluate(id, jsScript, program.files);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]).toBeDefined();
  });

  it("compile returns JS, evaluate executes it", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 'hello';",
        },
      ],
    };

    // compile() should not execute the JS
    const { jsScript, id } = await engine.compile(program);
    expect(jsScript.js).toBeDefined();

    // evaluate() should execute it
    const result = await engine.evaluate(id, jsScript, program.files);
    expect(result.main!["default"]).toBe("hello");
  });

  it("compile+evaluate returns the default export pattern", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { pattern } from 'commontools';",
            "const defaultPattern = pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
            "export default defaultPattern;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

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

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

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
            "/// <cts-enable />",
            "import { pattern } from 'commontools';",
            "export const myPattern = pattern<{ x: number }>(({ x }) => ({ x }));",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main).toBeDefined();
    expect(main!["myPattern"]).toBeDefined();
    expect(main!["myPattern"].nodes).toBeDefined();
  });

  it("evaluates with the SES module-load global surface", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "export function readGlobalSurface() {",
            "  const proxyType = typeof Proxy;",
            "  const fetchType = typeof fetch;",
            "  const dateType = typeof Date;",
            "  const dateNowType = typeof Date.now;",
            "  const epoch = new Date(0).getUTCFullYear();",
            "  const randomType = typeof Math.random;",
            "  const scType = typeof structuredClone;",
            "  const cloned = structuredClone({ nested: ['ok'] });",
            "  const evalType = typeof eval;",
            "  const functionType = typeof Function;",
            "  const helperKey = '__ct' + 'Helpers';",
            "  const helpers = Reflect.get(globalThis, helperKey) as { h: unknown };",
            "  const helperType = typeof helpers.h;",
            "  const helpersFrozen = Object.isFrozen(helpers);",
            "  const hFrozen = Object.isFrozen(helpers.h);",
            "  return `${proxyType}:${fetchType}:${dateType}:${dateNowType}:${epoch}:${randomType}:${scType}:${cloned.nested[0]}:${evalType}:${functionType}:${helperType}:${helpersFrozen}:${hFrozen}`;",
            "}",
            "export default readGlobalSurface;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main).toBeDefined();
    expect(typeof main!["default"]).toBe("function");
    expect((main!["default"] as () => string)()).toBe(
      "undefined:undefined:function:function:1970:function:function:ok:function:function:function:true:true",
    );
  });

  it("normalizes returned internal cells to value schemas on SES-evaluated patterns", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { cell, pattern } from 'commontools';",
            "const mainPattern = pattern(() => {",
            "  const audit = cell({ updates: 0, checksum: 0 });",
            "  return { audit };",
            "});",
            "export default mainPattern;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);
    const auditSchema = (main!["default"] as {
      resultSchema?: { properties?: Record<string, Record<string, unknown>> };
    }).resultSchema?.properties?.audit;

    expect(auditSchema).toBeDefined();
    expect(auditSchema?.["asCell"]).toBeUndefined();
    expect(auditSchema?.["asOpaque"]).toBe(true);
  });

  it("preserves computed helper behavior for SES-hoisted internal lifts without opaque unknown schemas", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            "import { computed, pattern, str } from 'commontools';",
            "const defaults = [{ title: 'Launch Announcement' }];",
            "const normalizeDrafts = (drafts: readonly { title: string }[] | undefined) =>",
            "  Array.isArray(drafts) && drafts.length > 0 ? drafts : defaults;",
            "const countDrafts = (drafts: readonly { title: string }[]) => drafts.length;",
            "const mainPattern = pattern<{ drafts?: { title: string }[] }>(({ drafts }) => {",
            "  const queue = computed(() => normalizeDrafts(drafts));",
            "  const count = computed(() => countDrafts(queue));",
            "  const label = str`${count} drafts awaiting`;",
            "  return { queue, label };",
            "});",
            "export default mainPattern;",
          ].join("\n"),
        },
      ],
    };

    const patternFactory = await runtime.patternManager.compilePattern(program);
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ label: string }>(
      signer.did(),
      { scenario: "hoisted-lifts" },
      patternFactory.resultSchema,
      tx,
    );
    const result = runtime.run(tx, patternFactory, {}, resultCell);
    tx.commit();
    const cancel = result.sink(() => {});
    await runtime.idle();

    try {
      expect(await result.key("label").pull()).toBe("1 drafts awaiting");
      expect(await result.key("queue").key(0).key("title").pull()).toBe(
        "Launch Announcement",
      );
    } finally {
      cancel();
    }
  });
});

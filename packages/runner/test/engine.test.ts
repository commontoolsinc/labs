import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

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
          contents: "export default 42;",
        },
      ],
    };

    const result = await engine.compile(program);

    expect(result.jsScript).toBeDefined();
    expect(result.jsScript.js).toBeDefined();
    expect(typeof result.jsScript.js).toBe("string");
    expect(result.jsScript.js.length).toBeGreaterThan(0);
    expect(result.id).toBeDefined();
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
          contents:
            "import { double } from './utils.ts'; export default double(21);",
        },
      ],
    };

    const result = await engine.compile(program);

    expect(result.jsScript).toBeDefined();
    expect(result.jsScript.js).toContain("double");
  });

  it("accepts default-import normalization in compiled SES bundles", async () => {
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

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(jsScript.js).toContain("__importDefault");
    expect(main?.default).toBe(21);
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

  it("emits __ct_data for CTS top-level data and evaluates it at runtime", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            'const lookup = (() => ({ open: "Open" }))();',
            "export default lookup.open;",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);

    expect(jsScript.js).toContain("__ct_data");

    const { main } = await engine.evaluate(id, jsScript, program.files);
    expect(main?.default).toBe("Open");
  });

  it("rewrites Date.now() and Math.random() to explicit SES-safe helpers", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "/// <cts-enable />",
            "const startedAt = Date.now();",
            "const seed = Math.random();",
            "export default function probe() {",
            "  return {",
            "    startedAt,",
            "    seed,",
            "    now: Date.now(),",
            "    random: Math.random(),",
            "  };",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    expect(jsScript.js).toContain("safeDateNow");
    expect(jsScript.js).toContain("nonPrivateRandom");

    const { main } = await engine.evaluate(id, jsScript, program.files);
    const result = main?.default();

    expect(typeof result?.startedAt).toBe("number");
    expect(typeof result?.now).toBe("number");
    expect(typeof result?.seed).toBe("number");
    expect(typeof result?.random).toBe("number");
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
          contents:
            "export const double = (x: number) => x * 2; export const triple = (x: number) => x * 3;",
        },
        {
          name: "/main.tsx",
          contents:
            "import { double } from './utils.ts'; export default double(21);",
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

  it("allows top-level schema() without CTS because it is a runtime helper", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { schema } from "commontools";',
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

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main).toBeDefined();
    expect(main!["default"]).toEqual({
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    });
  });

  it("allows explicit snapshot helpers without CTS", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { nonPrivateRandom, safeDateNow } from "commontools";',
            "const startedAt = safeDateNow();",
            "const seed = nonPrivateRandom();",
            "export default { startedAt, seed };",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(typeof main?.default?.startedAt).toBe("number");
    expect(typeof main?.default?.seed).toBe("number");
  });

  it("throws when handler() relies on CTS inference without CTS", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { handler } from "commontools";',
            "export default handler((_event: { count: number }, state: { count: number }) => {",
            "  state.count = state.count + 1;",
            "});",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    await expect(engine.evaluate(id, jsScript, program.files)).rejects.toThrow(
      "Handler requires schemas or CTS transformer",
    );
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

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

    expect(main?.default).toBe(42);
  });

  it("allows direct top-level builder definitions with schema constants", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, schema } from "commontools";',
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

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);

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
            "/// <cts-enable />",
            'import { lift } from "commontools";',
            'const labels = (() => ({ open: "Open" }))();',
            "export default lift(() => labels.open);",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    expect(jsScript.js).toContain("__ct_data");

    const { main } = await engine.evaluate(id, jsScript, program.files);
    expect(main?.default).toBeDefined();
  });

  it("allows CTS-wrapped accessor-backed data snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            'import { lift } from "commontools";',
            "const lookup = {",
            '  get open() { return "Open"; },',
            "};",
            "export default lift(() => lookup.open);",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    expect(jsScript.js).toContain("__ct_data");

    const { main } = await engine.evaluate(id, jsScript, program.files);
    expect(main?.default).toBeDefined();
  });

  it("allows CTS-wrapped proxy-backed data snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            'import { lift } from "commontools";',
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

    const { jsScript, id } = await engine.compile(program);
    expect(jsScript.js).toContain("__ct_data");

    const { main } = await engine.evaluate(id, jsScript, program.files);
    expect(main?.default).toBeDefined();
  });

  it("allows CTS-wrapped symbol-keyed data snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "/// <cts-enable />",
            'import { lift } from "commontools";',
            "const lookup = (() => {",
            '  const tag = Symbol("open");',
            '  return { [tag]: "Open" };',
            "})();",
            "export default lift(() => Object.getOwnPropertySymbols(lookup).length);",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    expect(jsScript.js).toContain("__ct_data");

    const { main } = await engine.evaluate(id, jsScript, program.files);
    expect(main?.default).toBeDefined();
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

    await expect(engine.compile(program)).rejects.toThrow(
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
            "const state = (() => ({ count: 0 }))();",
            "export default 42;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compile(program)).rejects.toThrow(
      "Only trusted builder calls",
    );
  });

  it("rejects trusted-builder callbacks that capture top-level data", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            "const state = { count: 0 };",
            "export default lift(() => state.count + 1);",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compile(program)).rejects.toThrow(
      "Callback captures top-level data binding 'state'",
    );
  });

  it("rejects untransformed toSchema() before evaluation in SES mode", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { toSchema } from "commontools";',
            "export default toSchema<{ count: number }>({",
            "  default: { count: 0 },",
            "});",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compile(program)).rejects.toThrow(
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

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);
    expect(() => (main?.default as () => number)()).toThrow();
  });

  it("hardens trusted builder callbacks against hidden mutable state", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commontools";',
            "export default lift(function step() {",
            "  const self = step as typeof step & { count?: number };",
            "  self.count = (self.count ?? 0) + 1;",
            "  return self.count;",
            "});",
          ].join("\n"),
        },
      ],
    };

    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);
    const implementation = (main?.default as {
      implementation: () => number;
    }).implementation;

    expect(() => implementation()).toThrow();
  });

  it("reconstructs stringified functions without raw eval", () => {
    const next = engine.getInvocation("function next(x) { return x + 1; }") as (
      input: number,
    ) => number;

    expect(next(1)).toBe(2);
  });

  it("rehydrates stringified functions in the smaller callback compartment", () => {
    const probe = engine.getInvocation(
      "function probe() { return typeof globalThis.RUNTIME_ENGINE_CONSOLE_HOOK; }",
    ) as () => string;

    expect(probe()).toBe("undefined");
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
            "import { pattern } from 'commonfabric';",
            "export default pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
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
            "import { pattern } from 'commonfabric';",
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
});

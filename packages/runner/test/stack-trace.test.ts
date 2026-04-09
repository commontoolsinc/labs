import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  JsScript,
  TypeScriptCompiler,
  type TypeScriptCompilerOptions,
} from "@commonfabric/js-compiler";
import { StaticCacheFS } from "@commonfabric/static";
import { CommonFabricTransformerPipeline } from "@commonfabric/ts-transformers";
import { SESRuntime } from "../src/sandbox/mod.ts";

const types = await getTypeScriptEnvironmentTypes(new StaticCacheFS());

/**
 * Tests that verify stack traces from compiled pattern code are correctly
 * source-mapped back to original TypeScript source locations.
 *
 * These tests exercise the same code path that runs in production:
 * TypeScript → compile → eval → error → source map → readable stack trace.
 *
 * Source files use explicit \n-separated strings (no template indentation)
 * so that line numbers are predictable and match source map output exactly.
 */

function compile(
  files: Record<string, string>,
  filename = "pattern-test.js",
  extraOptions: Partial<TypeScriptCompilerOptions> = {},
) {
  const compiler = new TypeScriptCompiler(types);
  const mainFile = Object.keys(files)[0];
  const program = new InMemoryProgram(mainFile, files);
  return compiler.resolveAndCompile(program, {
    filename,
    bundleExportAll: true,
    ...extraOptions,
  });
}

function compileWithCTS(
  files: Record<string, string>,
  filename = "pattern-test.js",
) {
  return compile(files, filename, {
    beforeTransformers: (program) => {
      const pipeline = new CommonFabricTransformerPipeline();
      return {
        factories: pipeline.toFactories(program),
        getDiagnostics: () => pipeline.getDiagnostics(),
      };
    },
  });
}

function execute(
  bundled: JsScript,
): {
  main: Record<string, unknown>;
  runtime: SESRuntime;
} {
  const runtime = new SESRuntime({ lockdown: true });
  const isolate = runtime.getIsolate("");
  const evaledBundle = isolate.execute(bundled);
  const result = evaledBundle.invoke().inner();
  if (
    result && typeof result === "object" && "main" in result &&
    "exportMap" in result
  ) {
    return {
      main: result.main as Record<string, unknown>,
      runtime,
    };
  }
  throw new Error("Unexpected evaluation result.");
}

function invokeInRuntime<TArgs extends unknown[], TResult>(
  runtime: SESRuntime,
  fn: (...args: TArgs) => TResult,
  ...args: TArgs
): TResult {
  return runtime.getIsolate("").value(fn).invoke(...args).inner() as TResult;
}

describe("Stack trace source mapping", () => {
  it("maps top-level error to exact original source locations", async () => {
    // helper.ts line 2 = throw, main.tsx line 2 = call site
    const compiled = await compile({
      "/main.tsx": [
        "import { fail } from './helper.ts';",
        "export default fail();",
      ].join("\n"),
      "/helper.ts": [
        "export function fail(): never {",
        "  throw new Error('compile-time boom');",
        "}",
      ].join("\n"),
    });

    let thrown: Error | undefined;
    try {
      execute(compiled);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const stack = thrown!.stack!.split("\n");
    stack.length = 6;

    expect(stack).toEqual([
      "Error: compile-time boom",
      "    at fail (helper.ts:2:8)",
      "    at Object.eval (main.tsx:2:19)",
      "    at <CF_INTERNAL>",
      "    at <CF_INTERNAL>",
      "    at <CF_INTERNAL>",
    ]);
  });

  it("maps deferred function error to exact source line", async () => {
    // Line 3 = throw new Error('negative input')
    const compiled = await compile({
      "/main.tsx": [
        "export function riskyOperation(val: number): number {",
        "  if (val < 0) {",
        "    throw new Error('negative input');",
        "  }",
        "  return val * 2;",
        "}",
        "export default { riskyOperation };",
      ].join("\n"),
    });

    const { main, runtime } = execute(compiled);
    const riskyOperation = (main as any).riskyOperation as (
      val: number,
    ) => number;

    expect(invokeInRuntime(runtime, riskyOperation, 5)).toBe(10);

    let thrown: Error | undefined;
    try {
      invokeInRuntime(runtime, riskyOperation, -1);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const mapped = runtime.parseStack(thrown!.stack!);
    const lines = mapped.split("\n");

    expect(lines[0]).toBe("Error: negative input");
    expect(lines[1]).toBe("    at riskyOperation (main.tsx:3:10)");
  });

  it("preserves relative and absolute runner internal stack frames by default", () => {
    const runtime = new SESRuntime({ lockdown: true });
    const stack = [
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "  at packages/runner/src/sandbox/ses-runtime.ts:100:15",
      "    at SESInternals.exec (packages/runner/src/sandbox/ses-runtime.ts:45:22)",
      "    at /home/runner/work/labs/labs/packages/runner/src/harness/engine.ts:244:45",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ].join("\n");

    expect(runtime.parseStack(stack).split("\n")).toEqual([
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "  at packages/runner/src/sandbox/ses-runtime.ts:100:15",
      "    at SESInternals.exec (packages/runner/src/sandbox/ses-runtime.ts:45:22)",
      "    at /home/runner/work/labs/labs/packages/runner/src/harness/engine.ts:244:45",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ]);
  });

  it("can sanitize relative and absolute runner internal stack frames", () => {
    const runtime = new SESRuntime({
      lockdown: true,
      hideInternalStackFrames: true,
    });
    const stack = [
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "  at packages/runner/src/sandbox/ses-runtime.ts:100:15",
      "    at SESInternals.exec (packages/runner/src/sandbox/ses-runtime.ts:45:22)",
      "    at /home/runner/work/labs/labs/packages/runner/src/harness/engine.ts:244:45",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ].join("\n");

    expect(runtime.parseStack(stack).split("\n")).toEqual([
      "Error: boom",
      "    at eval (main.tsx:6:12)",
      "    at <CF_INTERNAL>",
      "    at <CF_INTERNAL>",
      "    at <CF_INTERNAL>",
      "  at callback (ext:deno_web/02_timers.js:42:7)",
    ]);
  });

  it("maps multi-file error with exact line numbers through call chain", async () => {
    // validator.ts line 3 = throw, processor.ts line 3 = validate() call
    const compiled = await compile({
      "/main.tsx": [
        "import { processData } from './processor.ts';",
        "export default processData;",
      ].join("\n"),
      "/processor.ts": [
        "import { validate } from './validator.ts';",
        "export function processData(input: string): string {",
        "  validate(input);",
        "  return input.toUpperCase();",
        "}",
      ].join("\n"),
      "/validator.ts": [
        "export function validate(input: string): void {",
        "  if (!input || input.length === 0) {",
        "    throw new Error('validation failed: empty input');",
        "  }",
        "}",
      ].join("\n"),
    });

    const { main, runtime } = execute(compiled);
    const processData = main.default as (input: string) => string;

    let thrown: Error | undefined;
    try {
      invokeInRuntime(runtime, processData, "");
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const mapped = runtime.parseStack(thrown!.stack!);
    const lines = mapped.split("\n");

    expect(lines[0]).toBe("Error: validation failed: empty input");
    expect(lines[1]).toBe("    at validate (validator.ts:3:10)");
    expect(lines[2]).toBe("    at processData (processor.ts:3:11)");
  });

  it("preserves function name with exact source location", async () => {
    // Line 2 = throw new Error('zero!')
    const compiled = await compile({
      "/main.tsx": [
        "export function myNamedFunction(x: number): number {",
        "  if (x === 0) throw new Error('zero!');",
        "  return 1 / x;",
        "}",
        "export default { myNamedFunction };",
      ].join("\n"),
    });

    const { main, runtime } = execute(compiled);
    const fn = (main as any).myNamedFunction as (x: number) => number;

    let thrown: Error | undefined;
    try {
      invokeInRuntime(runtime, fn, 0);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const mapped = runtime.parseStack(thrown!.stack!);
    const lines = mapped.split("\n");

    expect(lines[0]).toBe("Error: zero!");
    expect(lines[1]).toBe("    at myNamedFunction (main.tsx:2:21)");
  });

  it("maps async error to exact source line", async () => {
    // Line 3 = throw new Error('async error')
    const compiled = await compile({
      "/main.tsx": [
        "export async function asyncBoom(): Promise<never> {",
        "  await Promise.resolve();",
        "  throw new Error('async error');",
        "}",
        "export default { asyncBoom };",
      ].join("\n"),
    });

    const { main, runtime } = execute(compiled);
    const asyncBoom = (main as any).asyncBoom as () => Promise<never>;

    let thrown: Error | undefined;
    try {
      await invokeInRuntime(runtime, asyncBoom);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const mapped = runtime.parseStack(thrown!.stack!);
    const lines = mapped.split("\n");

    expect(lines[0]).toBe("Error: async error");
    expect(lines[1]).toBe("    at asyncBoom (main.tsx:3:8)");
  });

  it("returns stack unchanged when no source map is loaded", () => {
    const runtime = new SESRuntime({ lockdown: true });

    const stack = `Error: something broke
    at someFunction (unknown-file.js:10:5)
    at Object.eval (another-file.js:20:10)`;

    const result = runtime.parseStack(stack);
    expect(result).toBe(stack);
  });
});

describe("Stack trace source mapping with CTS transformer", () => {
  // Full CTS pattern transformation + source map integration tests are in
  // stack-trace-patterns.test.ts which runs through
  // the real pattern compilation pipeline with full runtime types.

  it("preserves source positions for non-reactive code through CTS pipeline", async () => {
    // Even with CTS enabled, code that doesn't use reactive patterns
    // should still have correct source maps (CTS is a no-op for this code).
    const compiled = await compileWithCTS({
      "/main.tsx": [
        "export function validate(x: number): number {", // line 1
        "  if (x < 0) {", // line 2
        "    throw new Error('negative');", // line 3
        "  }", // line 4
        "  return x * 2;", // line 5
        "}", // line 6
        "export default { validate };", // line 7
      ].join("\n"),
    });

    const { main, runtime } = execute(compiled);
    const validate = (main as any).validate as (x: number) => number;

    expect(invokeInRuntime(runtime, validate, 5)).toBe(10);

    let thrown: Error | undefined;
    try {
      invokeInRuntime(runtime, validate, -1);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeDefined();
    const mapped = runtime.parseStack(thrown!.stack!);
    const lines = mapped.split("\n");

    expect(lines[0]).toBe("Error: negative");
    expect(lines[1]).toBe("    at validate (main.tsx:3:10)");
  });
});

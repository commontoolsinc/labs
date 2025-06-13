import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  JsScript,
  TypeScriptCompiler,
  UnsafeEvalJsValue,
  UnsafeEvalRuntime,
} from "../mod.ts";

const types = await getTypeScriptEnvironmentTypes();

describe("Runtime", () => {
  it("Compiles and executes a set of typescript files", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from './utils.ts';export default add(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
    });
    const compiled = await compiler.resolveAndCompile(program);
    const exports = execute(compiled).invoke();
    expect(exports.inner().default).toBe(12);
  });

  it("Executes with runtime dependencies", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    const compiled = await compiler.resolveAndCompile(program, {
      runtimeModules: ["@std/math"],
    });
    const exports = execute(compiled).invoke({
      "@std/math": {
        add(x: number, y: number): number {
          return x + y;
        },
      },
    });
    expect(exports.inner().default).toBe(12);
  });

  it("Source maps errors on invoke", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `// main.tsx
      import { doubleOrThrow } from "./utils.ts";

      export default doubleOrThrow(undefined);
      `,
      "/utils.ts": `// utils.ts
      export function doubleOrThrow(input: number | undefined): number {
        if (typeof input === "number") {
          return input * 2;
        }
        throw new Error("throwing!");
      }
      `,
    });
    const compiled = await compiler.resolveAndCompile(program, {
      filename: "recipe-abc.js",
    });
    let thrown: Error | undefined;
    try {
      const exports = execute(compiled).invoke();
      expect(exports.inner().default).toBe(12);
    } catch (e: any) {
      thrown = e as Error;
    } finally {
      expect(thrown).toBeDefined();
      const stack = thrown!.stack!.split("\n");
      stack.length = 6;
      const expected = [
        "Error: throwing!",
        "    at doubleOrThrow (utils.ts:6:14)",
        "    at Object.eval (main.tsx:4:35)",
        "    at <CT_INTERNAL>",
        "    at <CT_INTERNAL>",
        "    at <CT_INTERNAL>",
      ];

      expect(stack.join("\n")).toBe(expected.join("\n"));
    }
  });
});

function execute(bundled: JsScript): UnsafeEvalJsValue {
  const runtime = new UnsafeEvalRuntime();
  const isolate = runtime.getIsolate("");
  return isolate.execute(bundled);
}

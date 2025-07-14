import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  JsScript,
  TypeScriptCompiler,
  UnsafeEvalRuntime,
} from "../mod.ts";
import { StaticCache } from "@commontools/static";

const types = await getTypeScriptEnvironmentTypes(new StaticCache());

describe("Runtime", () => {
  it("Compiles and executes a set of typescript files", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from './utils.ts';export default add(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
    });
    const compiled = await compiler.resolveAndCompile(program, {
      bundleExportAll: true,
    });
    const { main, exportMap: _ } = execute(compiled);
    expect(main.default).toBe(12);
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
      bundleExportAll: true,
    });
    const { main, exportMap: _ } = execute(compiled, {
      "@std/math": {
        add(x: number, y: number): number {
          return x + y;
        },
      },
    });
    expect(main.default).toBe(12);
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
      bundleExportAll: true,
    });
    let thrown: Error | undefined;
    try {
      const { main, exportMap: _ } = execute(compiled);
      expect(main.default).toBe(12);
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

  it("Exports all file exports", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx":
        "import { add } from '/utils/foo.ts';export default add(10,2); export const foo = 'bar';",
      "/utils/foo.ts":
        "import * as math from '@std/math'; export const add = (x: number, y: number) => math.add(x, y); export const sub = (x: number, y: number): number => x - y;",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    const compiled = await compiler.resolveAndCompile(program, {
      runtimeModules: ["@std/math"],
      bundleExportAll: true,
    });
    const { main: _, exportMap } = execute(compiled, {
      "@std/math": {
        add(x: number, y: number): number {
          return x + y;
        },
      },
    });
    expect(Object.keys(exportMap).length).toBe(2);
    expect(Object.keys(exportMap["/main.tsx"]).length).toBe(2);
    expect(exportMap["/main.tsx"]["default"]).toBe(12);
    expect(exportMap["/main.tsx"]["foo"]).toBe("bar");
    expect(exportMap["/utils/foo.ts"]["add"]).toBeInstanceOf(Function);
    expect(exportMap["/utils/foo.ts"]["sub"]).toBeInstanceOf(Function);
  });
});

function execute(
  bundled: JsScript,
  rtBundle?: object,
): {
  main: Record<string, any>;
  exportMap: Record<string, Record<string, any>>;
} {
  const runtime = new UnsafeEvalRuntime();
  const isolate = runtime.getIsolate("");
  const evaledBundle = isolate.execute(bundled);
  const result = rtBundle !== undefined
    ? evaledBundle.invoke(rtBundle).inner()
    : evaledBundle.invoke().inner();
  if (
    result && typeof result === "object" && "main" in result &&
    "exportMap" in result
  ) {
    return {
      main: result.main as Record<string, any>,
      exportMap: result.exportMap as Record<string, Record<string, any>>,
    };
  }
  throw new Error("Unexpected evaluation result.");
}

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  bundle,
  getTypeLibs,
  TypeScriptCompiler,
  UnsafeEvalRuntime,
} from "../mod.ts";
import { execute, unrollFiles } from "./utils.ts";

describe("Runtime", () => {
  it("Compiles and executes a set of typescript files", async () => {
    const files = {
      "/main.tsx": "import { add } from './utils.ts';export default add(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
    };
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(unrollFiles(files));
    const bundled = bundle({ source: compiled, filename: "out.js" });
    const exports = execute(bundled);
    expect(exports.inner().default).toBe(12);
  });

  it("Executes with runtime dependencies", async () => {
    const files = {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    };
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(unrollFiles(files));
    const bundled = bundle({
      source: compiled,
      filename: "out.js",
      runtimeDependencies: true,
    });
    const exports = execute(bundled).invoke({
      "@std/math": {
        add(x: number, y: number): number {
          return x + y;
        },
      },
    });
    expect(exports.inner().default).toBe(12);
  });
});

describe("Runtime TODO", () => {
  it.skip("Source maps errors on invoke", async () => {
    const files = {
      "/main.tsx":
        "import { throwIfNot1 } from './utils.ts';export default throwIfNot1(0);",
      "/utils.ts":
        "export const throwIfNot1 =(x:number)=>{if(x!==1)throw new Error('not 1')};",
    };
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(unrollFiles(files));
    const bundled = bundle({ filename: "abcdef.tsx", source: compiled });
    const runtime = new UnsafeEvalRuntime();
    const isolate = runtime.getIsolate("");
    try {
      const result = isolate.execute(bundled);
      expect(result.inner().default).toBe(12);
    } catch (e: any) {
      console.log(
        "INVOKE ERROR",
        e,
        "message" in e && e.message,
        "stack" in e && e.stack,
      );
    }
  });
});

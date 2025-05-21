import { describe, it } from "@std/testing/bdd";
import { bundle, TypeScriptCompiler } from "../mod.ts";
import { expect } from "@std/expect/expect";

describe("Bundler", () => {
  it("bundles a graph", async () => {
    const files = {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export default sub(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    };
    const compiler = await TypeScriptCompiler.initialize();
    const compiled = compiler.compile({ entry: "/main.tsx", files });
    const bundled = bundle({ source: compiled });
  });
});

import { describe, it } from "@std/testing/bdd";
import { bundle, getTypeLibs, TypeScriptCompiler } from "../mod.ts";
import { unrollFiles } from "./utils.ts";

describe("Bundler", () => {
  it("bundles a graph", async () => {
    const files = {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export default sub(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    };
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(unrollFiles(files));
    const bundled = bundle({ source: compiled });
  });
});

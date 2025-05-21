import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { TypeScriptCompiler } from "../mod.ts";

describe("TypeScriptCompiler", () => {
  it("compiles a filesystem graph", async () => {
    const files = {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export default sub(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    };
    const compiler = await TypeScriptCompiler.initialize();
    const compiled = compiler.compile({ entry: "/main.tsx", files });
    expect(compiled.modules["/main.js"].originalFilename).toBe("/main.tsx");
    expect(compiled.modules["/utils.js"].originalFilename).toBe("/utils.ts");
    expect(compiled.modules["/math/subtract.js"].originalFilename).toBe(
      "/math/subtract.ts",
    );
  });

  it("type checks", async () => {
    const files = {
      "/main.tsx":
        "import { add } from './utils.ts';export default add(`0`, 2);",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
    };
    const compiler = await TypeScriptCompiler.initialize();
    expect(() => compiler.compile({ entry: "/main.tsx", files })).toThrow(
      "Argument of type 'string' is not assignable to parameter of type 'number'.",
    );
  });

  // Tests that the proper type "lib"s are loaded.
  it("Default es2023 types applied", async () => {
    const files = {
      "/main.tsx": "export default new Map();",
    };
    const compiler = await TypeScriptCompiler.initialize();
    const compiled = compiler.compile({ entry: "/main.tsx", files });
    expect(Object.keys(compiled.modules).length).toBe(1);
  });
});

describe("TypeScriptCompiler failures", () => {
  it("throws on invalid JS", async () => {
    const files = {
      "/main.tsx": "}x",
    };
    const compiler = await TypeScriptCompiler.initialize();
    expect(() => compiler.compile({ entry: "/main.tsx", files })).toThrow(
      "Cannot find name 'x'.",
    );
  });

  it("throws if invalid graph", async () => {
    const files = {
      "/main.tsx": "import { foo } from './foo.ts';export default foo()",
    };
    const compiler = await TypeScriptCompiler.initialize();
    expect(() => compiler.compile({ entry: "/main.tsx", files })).toThrow(
      "Cannot find module './foo.ts'",
    );
  });
});

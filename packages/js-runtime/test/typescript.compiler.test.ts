import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  TypeScriptCompiler,
  TypeScriptCompilerOptions,
} from "../mod.ts";
import { StaticCache } from "@commontools/static";

type TestDef =
  & { name: string; source: string; expectedError?: string }
  & TypeScriptCompilerOptions;

const TESTS: TestDef[] = [
  {
    name: "Default es2023 types applied",
    source: "export default new Map()",
  },
  {
    name: "Default lib.d.ts applied",
    source:
      "const x: Readonly<{ value: number }> = {value:5}; export default x;",
  },
  {
    name: "Throws: type check failure",
    source:
      "function add(x:number, y:number): number {return x+y}; export default add(`0`, 2);",
    expectedError:
      "Argument of type 'string' is not assignable to parameter of type 'number'.",
  },
  {
    name: "Throws: Invalid source",
    source: "}x",
    expectedError: "Cannot find name 'x'.",
  },
  {
    name: "Throws: Invalid import",
    source: "import { foo } from './foo.ts';export default foo()",
    expectedError: "Cannot find module './foo.ts'",
  },
];

const staticCache = new StaticCache();
const types = await getTypeScriptEnvironmentTypes(staticCache);
types["commontools.d.ts"] = await staticCache.getText(
  "types/commontools.d.ts",
);

describe("TypeScriptCompiler", () => {
  it("compiles a filesystem graph", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export default sub(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    });
    const compiled = await compiler.resolveAndCompile(program, {
      filename: "test.js",
    });
    expect(compiled.filename).toBe("test.js");
    expect(compiled.sourceMap).toBeDefined();
  });

  it("Typechecks a runtime dependency, providing typedefs", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    await compiler.resolveAndCompile(program, {
      runtimeModules: ["@std/math"],
    });
  });

  it("Throws if runtime module not defined", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    await expect(compiler.resolveAndCompile(program)).rejects.toThrow();
  });

  it("Handles untyped JS files", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '/math.js';export default add(10,2)",
      "/math.js": "export function add(x, y) { return x + y; }",
    });
    await compiler.resolveAndCompile(program);
  });

  it("Inlines errors", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function add(x: number, y: number): number {
  return x + y;
} 

export default add(5, "5");`,
    });

    const expected = `4 | } 
5 | 
6 | export default add(5, \"5\");
  |                       ^
`;
    await expect(compiler.resolveAndCompile(program)).rejects.toThrow(expected);
  });

  for (const { name, source, expectedError, ...options } of TESTS) {
    it(name, () => {
      const artifact = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      };
      const compiler = new TypeScriptCompiler(types);
      if (expectedError) {
        expect(() => compiler.compile(artifact, options)).toThrow(
          expectedError,
        );
      } else compiler.compile(artifact, options);
    });
  }
});

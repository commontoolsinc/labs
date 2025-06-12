import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getTypeLibs,
  TypeScriptCompiler,
  TypeScriptCompilerOptions,
} from "../mod.ts";
import { TestProgram } from "./utils.ts";
import { resolveProgram } from "../typescript/resolver.ts";
import { TARGET } from "../typescript/options.ts";

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

describe("TypeScriptCompiler", () => {
  it("compiles a filesystem graph", async () => {
    const program = new TestProgram("/main.tsx", {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export default sub(10,2)",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    });
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    const compiled = compiler.compile(program, { filename: "test.js" });
    expect(compiled.filename).toBe("test.js");
    expect(compiled.sourceMap).toBeDefined();
  });

  it("Typechecks a runtime dependency, providing typedefs", async () => {
    const program = new TestProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    compiler.compile(program, { runtimeModules: ["@std/math"] });
  });

  it("Throws if runtime module not defined", async () => {
    const program = new TestProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    const compiler = new TypeScriptCompiler(await getTypeLibs());
    expect(() => compiler.compile(program)).toThrow();
  });

  for (const { name, source, expectedError, ...options } of TESTS) {
    it(name, async () => {
      const artifact = {
        entry: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      };
      const compiler = new TypeScriptCompiler(await getTypeLibs());
      if (expectedError) {
        expect(() => compiler.compile(artifact, options)).toThrow(
          expectedError,
        );
      } else compiler.compile(artifact, options);
    });
  }
});

describe("resolver", () => {
  describe("resolveProgram", () => {
    const graph = new TestProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    it("unresolvedModules.type allow-all", () => {
      const program = resolveProgram(
        graph,
        {
          unresolvedModules: { type: "allow-all" },
          resolveUnresolvedModuleTypes: true,
          target: TARGET,
        },
      );
      expect(program.files.length).toBe(2);
    });
    it("unresolvedModules.type allow", () => {
      const program = resolveProgram(
        graph,
        {
          unresolvedModules: { type: "allow", identifiers: ["@std/math"] },
          resolveUnresolvedModuleTypes: true,
          target: TARGET,
        },
      );
      expect(program.files.length).toBe(2);
      expect(() =>
        resolveProgram(
          graph,
          {
            unresolvedModules: { type: "allow", identifiers: [] },
            resolveUnresolvedModuleTypes: true,
            target: TARGET,
          },
        )
      ).toThrow(
        /Could not resolve/,
      );
    });
    it("unresolvedModules.type deny", () => {
      expect(() =>
        resolveProgram(
          graph,
          {
            unresolvedModules: { type: "allow", identifiers: [] },
            resolveUnresolvedModuleTypes: true,
            target: TARGET,
          },
        )
      ).toThrow(
        /Could not resolve/,
      );
    });
  });
});

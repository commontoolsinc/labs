import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  type SourceMap,
  TypeScriptCompiler,
  TypeScriptCompilerOptions,
} from "../mod.ts";
import { StaticCacheFS } from "@commonfabric/static";

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

const staticCache = new StaticCacheFS();
const types = await getTypeScriptEnvironmentTypes(staticCache);
types["commonfabric.d.ts"] = await staticCache.getText(
  "types/commonfabric.d.ts",
);

/** Resolve via the compiler's resolver, then emit per-module CommonJS. */
async function resolveAndCompileToModules(
  compiler: TypeScriptCompiler,
  program: InMemoryProgram,
  options: TypeScriptCompilerOptions = {},
): Promise<Map<string, { js: string; sourceMap?: SourceMap }>> {
  const resolved = await compiler.resolveProgram(program, options);
  return compiler.compileToModules(resolved, options);
}

describe("TypeScriptCompiler", () => {
  it("compileToModules emits per-module CommonJS for each source", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export const run = () => sub(10,2);export default run;",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    });
    const modules = await resolveAndCompileToModules(compiler, program);

    // One compiled CommonJS body per source file (no bundle).
    expect(new Set(modules.keys())).toEqual(
      new Set(["/main.tsx", "/utils.ts", "/math/subtract.ts"]),
    );
    const main = modules.get("/main.tsx")!;
    expect(main.js).toContain('require("./math/subtract.ts")');
    expect(main.js).toContain("exports.run");
    expect(main.sourceMap).toBeDefined();
    // No AMD wrapper / define() — this is bare CommonJS.
    expect(main.js).not.toContain("define(");
    expect(modules.get("/utils.ts")!.js).toContain("exports.add");
  });

  it("compileToModulesInterleaved emits byte-identical output to compileToModules", async () => {
    // The interleaved driver only changes WHERE the event loop can run
    // (macrotask yields at module boundaries) — never what is emitted. Pin
    // byte-for-byte equivalence across a multi-module program so the two
    // drivers cannot drift.
    const compiler = new TypeScriptCompiler(types);
    const files = {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export const run = () => sub(10,2);export default run;",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    };
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.tsx", files),
    );
    const sync = compiler.compileToModules(resolved);
    const interleaved = await compiler.compileToModulesInterleaved(resolved);

    expect(new Set(interleaved.keys())).toEqual(new Set(sync.keys()));
    for (const [name, out] of sync) {
      expect(interleaved.get(name)!.js).toBe(out.js);
      expect(JSON.stringify(interleaved.get(name)!.sourceMap)).toBe(
        JSON.stringify(out.sourceMap),
      );
    }
  });

  it("compileToModulesInterleaved surfaces type errors like compileToModules", async () => {
    const compiler = new TypeScriptCompiler(types);
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.tsx", {
        "/main.tsx":
          "function add(x:number, y:number): number {return x+y}; export default add(`0`, 2);",
      }),
    );
    const expected =
      "Argument of type 'string' is not assignable to parameter of type 'number'.";
    expect(() => compiler.compileToModules(resolved)).toThrow(expected);
    await expect(compiler.compileToModulesInterleaved(resolved)).rejects
      .toThrow(expected);
  });

  it("Compiles programs that include authored .js sources", async () => {
    // `allowJs` on the per-module emit path: a `.js` source emits its compiled
    // body under its own name (`/math.js` → `/math.js`), which TypeScript
    // normally vetoes as an input overwrite. The VirtualFs keeps reads and
    // writes separate, so the veto is suppressed (`suppressOutputPathCheck`).
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx":
        "import { add } from './math.js';export const run = () => add(1,2);export default run;",
      "/math.js": "export const add = (x, y) => x + y;",
    });
    const modules = await resolveAndCompileToModules(compiler, program);

    expect(new Set(modules.keys())).toEqual(
      new Set(["/main.tsx", "/math.js"]),
    );
    const main = modules.get("/main.tsx")!;
    expect(main.js).toContain('require("./math.js")');
    const math = modules.get("/math.js")!;
    expect(math.js).toContain("exports.add");
    expect(math.sourceMap).toBeDefined();
  });

  it("Throws when a .ts and .js source collide on one emit target", () => {
    const compiler = new TypeScriptCompiler(types);
    const artifact = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            "import { a } from './a.ts';import { b } from './a.js';export default [a, b];",
        },
        { name: "/a.ts", contents: "export const a = 1;" },
        { name: "/a.js", contents: "export const b = 2;" },
      ],
    };
    expect(() => compiler.compileToModules(artifact)).toThrow(
      "Ambiguous emit target",
    );
  });

  it("Typechecks a runtime dependency, providing typedefs", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    const modules = await resolveAndCompileToModules(compiler, program, {
      runtimeModules: ["@std/math"],
    });
    expect(modules.get("/main.tsx")!.js).toContain('require("@std/math")');
  });

  it("uses specifier aliases for type resolution without rewriting emitted imports", () => {
    const compiler = new TypeScriptCompiler(types);
    const specifierAliases = new Map([["x-scheme:thing", "/dep.tsx"]]);
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            `import { value } from "x-scheme:thing";\nexport const run = (): string => value;`,
        },
        {
          name: "/dep.tsx",
          contents: `export const value: string = "ok";`,
        },
      ],
    };

    const modules = compiler.compileToModules(program, { specifierAliases });
    expect(modules.get("/main.tsx")!.js).toContain(
      'require("x-scheme:thing")',
    );

    const badProgram = {
      ...program,
      files: [
        {
          name: "/main.tsx",
          contents:
            `import { missing } from "x-scheme:thing";\nexport const run = missing;`,
        },
        program.files[1],
      ],
    };
    expect(() => compiler.compileToModules(badProgram, { specifierAliases }))
      .toThrow(`has no exported member 'missing'.`);
  });

  it("Resolves nested relative type imports from runtime module typedefs", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts": `
export type { Num } from "./num.ts";
import type { Num } from "./num.ts";
export declare function add(x: Num, y: Num): Num;
`,
      "@std/num.ts": "export type Num = number;",
    });
    await resolveAndCompileToModules(compiler, program, {
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
    await expect(resolveAndCompileToModules(compiler, program)).rejects
      .toThrow();
  });

  it("Compiles TSX with standard-decorator accessor fields", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function tracked(
  _value: ClassAccessorDecoratorTarget<Counter, number>,
  _context: ClassAccessorDecoratorContext<Counter, number>,
) {
  return {
    init(value: number) {
      return value;
    },
  };
}

declare namespace JSX {
  interface IntrinsicElements {
    div: {};
  }
}

declare function h(
  tag: string,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): unknown;

class Counter {
  @tracked accessor count = 1;
}

export default <div>{new Counter().count}</div>;
`,
    });

    const modules = await resolveAndCompileToModules(compiler, program);
    const main = modules.get("/main.tsx");
    expect(main).toBeDefined();
    expect(main!.sourceMap).toBeDefined();
  });

  it("allows exported APIs to use scoped phantom wrapper types", async () => {
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
import type { PerUser } from "commonfabric";

export interface ScopedOutput {
  name: PerUser<string>;
}

export default function build(): ScopedOutput {
  return { name: "Ada" as PerUser<string> };
}
`,
      "commonfabric.d.ts": `
export declare const SCOPE_BRAND: unique symbol;
export type PerUser<T> = T & { readonly [SCOPE_BRAND]?: "user" };
`,
    });
    const compiler = new TypeScriptCompiler(types);
    await resolveAndCompileToModules(compiler, program, {
      runtimeModules: ["commonfabric"],
    });
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
    await expect(resolveAndCompileToModules(compiler, program)).rejects
      .toThrow(expected);
  });

  for (const { name, source, expectedError, ...options } of TESTS) {
    it(name, () => {
      const artifact = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      };
      const compiler = new TypeScriptCompiler(types);
      if (expectedError) {
        expect(() => compiler.compileToModules(artifact, options)).toThrow(
          expectedError,
        );
      } else {
        const modules = compiler.compileToModules(artifact, options);
        expect(modules.get("/main.tsx")).toBeDefined();
      }
    });
  }
});

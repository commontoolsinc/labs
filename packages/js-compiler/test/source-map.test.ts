import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  composeBundleSourceMap,
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  type SourceMap,
  SourceMapParser,
  TypeScriptCompiler,
} from "../mod.ts";
import { StaticCacheFS } from "@commonfabric/static";
import { SourceMapConsumer, SourceMapGenerator } from "source-map-js";

const staticCache = new StaticCacheFS();
const types = await getTypeScriptEnvironmentTypes(staticCache);
types["commonfabric.d.ts"] = await staticCache.getText(
  "types/commonfabric.d.ts",
);

/** Compile a single-module program and return its emitted CommonJS + map. */
async function compileMain(
  compiler: TypeScriptCompiler,
  program: InMemoryProgram,
): Promise<{ js: string; sourceMap?: SourceMap }> {
  const resolved = await compiler.resolveProgram(program);
  return compiler.compileToModules(resolved).get("/main.tsx")!;
}

/**
 * Mirror the ESM module-record loader's execution shape: wrap the compiled
 * CommonJS body in the 1-line factory wrapper tagged with a `//# sourceURL`,
 * eval it, and return the populated exports. Stack frames from inside the
 * module then carry `<filename>:<line>:<column>` coordinates relative to the
 * eval'd string (body line N = eval line N+1).
 */
function evaluateModule(
  js: string,
  filename: string,
): Record<string, (...args: unknown[]) => unknown> {
  const factory = (0, eval)(
    `(function (exports, require, module) {\n${js}\n})\n//# sourceURL=${filename}`,
  ) as (
    exports: Record<string, unknown>,
    require: (specifier: string) => Record<string, unknown>,
    module: { exports: Record<string, unknown> },
  ) => void;
  const exports: Record<string, unknown> = {};
  factory(exports, () => ({}), { exports });
  return exports as Record<string, (...args: unknown[]) => unknown>;
}

/**
 * The map the engine registers under a module's eval `//# sourceURL`: the
 * per-module compiler map shifted by the 1-line factory wrapper, with the
 * source path overridden to the full module path.
 */
function moduleSourceMap(map: SourceMap, sourceUrl: string): SourceMap {
  return composeBundleSourceMap(
    [{ body: "", map, source: "/main.tsx" }],
    sourceUrl,
    1, // the `(function (exports, require, module) {` wrapper line
  )!;
}

describe("SourceMap", () => {
  it("inspects source map structure", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function throwError(): never {
  throw new Error("test error");
}

export function test() {
  return throwError();
}

export default test;
`,
    });

    const compiled = await compileMain(compiler, program);

    console.log("=== Compiled Output ===");
    console.log(compiled.js);
    console.log("\n=== Source Map ===");
    console.log("file:", compiled.sourceMap?.file);
    console.log("sources:", compiled.sourceMap?.sources);
    console.log(
      "sourcesContent length:",
      compiled.sourceMap?.sourcesContent?.length,
    );
    console.log(
      "mappings (first 200 chars):",
      compiled.sourceMap?.mappings?.slice(0, 200),
    );

    expect(compiled.sourceMap).toBeDefined();

    // Parse the source map
    const consumer = new SourceMapConsumer(compiled.sourceMap!);
    let mapped = 0;

    console.log("\n=== Sample Position Mappings ===");
    // Check what various line/column positions map to
    for (let line = 1; line <= 10; line++) {
      for (const col of [0, 10, 20, 30]) {
        const pos = consumer.originalPositionFor({ line, column: col });
        if (pos.source !== null) {
          mapped++;
          console.log(
            `Line ${line}, Col ${col} -> ${pos.source}:${pos.line}:${pos.column} (name: ${pos.name})`,
          );
        }
      }
    }
    expect(mapped).toBeGreaterThan(0);
  });

  it("parses error stack traces with source map", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function throwError(): never {
  throw new Error("test error");
}

export function test() {
  return throwError();
}

export default test;
`,
    });

    const compiled = await compileMain(compiler, program);

    const parser = new SourceMapParser();
    parser.load(
      "test-error.js",
      moduleSourceMap(compiled.sourceMap!, "test-error.js"),
    );

    // Execute the compiled module the way the ESM loader does and get an error
    let threw = false;
    try {
      const exports = evaluateModule(compiled.js, "test-error.js");
      exports.test();
    } catch (e: any) {
      threw = true;
      console.log("\n=== Raw Error Stack ===");
      console.log(e.stack);

      const parsed = parser.parse(e.stack);
      console.log("\n=== Parsed (Source Mapped) Stack ===");
      console.log(parsed);

      // The throw on source line 3 must resolve back to the authored source.
      expect(parsed).toContain("main.tsx:3:");
    }
    expect(threw).toBe(true);
  });

  it("verifies error line mapping through full stack", async () => {
    const compiler = new TypeScriptCompiler(types);
    // Create a program where we know exactly which line should error
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `// line 1
// line 2
// line 3
// line 4
function errorOnLine6(): never {
  throw new Error("error from line 6"); // THIS IS LINE 6
}

export default errorOnLine6;
`,
    });

    const compiled = await compileMain(compiler, program);

    const parser = new SourceMapParser();
    parser.load(
      "known-line.js",
      moduleSourceMap(compiled.sourceMap!, "known-line.js"),
    );

    let threw = false;
    try {
      const exports = evaluateModule(compiled.js, "known-line.js");
      // Call the default export which should throw
      exports.default();
    } catch (e: any) {
      threw = true;
      const parsed = parser.parse(e.stack);
      console.log("\n=== Stack for known line 6 error ===");
      console.log("Raw:", e.stack);
      console.log("\nParsed:", parsed);

      // The error should mention line 6 from main.tsx
      expect(parsed).toContain("main.tsx");
      expect(parsed).toContain(":6:");
    }
    expect(threw).toBe(true);
  });

  it("matches various stack trace formats", () => {
    const parser = new SourceMapParser();
    // Don't load any source maps - we just want to test regex matching

    // Test patterns that should match (returns original line if no source map)
    const patterns = [
      // Standard function call
      "    at doubleOrThrow (recipe-abc.js, <anonymous>:14:15)",
      // Object method with [as factory]
      "    at Object.eval [as factory] (recipe-abc.js, <anonymous>:4:52)",
      // Object method with [as default]
      "    at Object.errorOnLine6 [as default] (known-line.js, <anonymous>:5:15)",
      // Function with digits
      "    at func123 (file.js, <anonymous>:1:1)",
      // Namespaced function
      "    at MyClass.myMethod (file.js, <anonymous>:10:5)",
      // Nested namespace
      "    at A.B.C.method (file.js, <anonymous>:20:10)",
      // Source-labeled function name used by runner action/module ids
      "    at ba4jcaraqictevfcqama4n7ugtfosjasodvm43iojcw4ss6m4y54d3uvn/main.tsx:3:19 (file.js, <anonymous>:20:10)",
      // eval
      "    at eval (recipe-abc.js, <anonymous>:17:10)",
      // AMDLoader methods
      "    at AMDLoader.resolveModule (recipe-abc.js, <anonymous>:1:1764)",
      "    at AMDLoader.require (recipe-abc.js, <anonymous>:1:923)",
    ];

    for (const pattern of patterns) {
      const input = `Error: test\n${pattern}`;
      const result = parser.parse(input);
      // Should either transform the line or leave it unchanged (not drop it)
      expect(result.includes("at ")).toBe(true);
    }
  });

  it("maps stack frames with source-labeled function names", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `// line 1
// line 2
// line 3
// line 4
function errorOnLine6(): never {
  throw new Error("error from line 6"); // THIS IS LINE 6
}

export default errorOnLine6;
`,
    });

    const compiled = await compileMain(compiler, program);

    const map = moduleSourceMap(compiled.sourceMap!, "known-line.js");
    const parser = new SourceMapParser();
    parser.load("known-line.js", map);

    // Find the eval-relative coordinate of the throw on authored line 6, so
    // the synthetic frame below points at a real mapping.
    const gen = new SourceMapConsumer(map).generatedPositionFor({
      source: "/main.tsx",
      line: 6,
      column: 2,
    });
    expect(gen.line).not.toBeNull();

    const parsed = parser.parse(`Error: test
    at ba4jcaraqictevfcqama4n7ugtfosjasodvm43iojcw4ss6m4y54d3uvn/main.tsx:3:19 (known-line.js, <anonymous>:${gen.line}:${gen.column})`);

    expect(parsed).toContain("main.tsx:6:");
  });

  it("preserves unmapped stack frames from external files", () => {
    const parser = new SourceMapParser();
    // Load a source map for a specific file
    const dummySourceMap = {
      version: "3",
      file: "test.js",
      sourceRoot: "",
      sources: ["test.tsx"],
      names: [],
      mappings: "AAAA",
      sourcesContent: ["test"],
    };
    parser.load("test.js", dummySourceMap);

    const stack = `Error: test
    at func (test.js, <anonymous>:1:1)
    at external (other-file.js:100:50)
    at anotherExternal (https://example.com/lib.js:200:30)`;

    const parsed = parser.parse(stack);

    // External files should be preserved unchanged
    expect(parsed).toContain("other-file.js:100:50");
    expect(parsed).toContain("https://example.com/lib.js:200:30");
  });
});

describe("composeBundleSourceMap", () => {
  const buildMap = (
    file: string,
    mappings: Array<{ gen: number; src: string; orig: number }>,
  ) => {
    const g = new SourceMapGenerator({ file });
    for (const m of mappings) {
      g.addMapping({
        generated: { line: m.gen, column: 0 },
        original: { line: m.orig, column: 0 },
        source: m.src,
      });
    }
    return JSON.parse(g.toString());
  };

  it("offsets each module's generated lines by its start in the joined bundle", () => {
    const mapA = buildMap("a.js", [
      { gen: 1, src: "a.ts", orig: 10 },
      { gen: 2, src: "a.ts", orig: 11 },
    ]);
    const mapB = buildMap("b.js", [{ gen: 1, src: "b.ts", orig: 20 }]);
    // Bodies joined with "\n": A occupies bundle lines 1..3 (3 lines), so B's
    // gen line 1 lands at bundle line 4.
    const composed = composeBundleSourceMap(
      [{ body: "x\ny\nz", map: mapA }, { body: "p\nq", map: mapB }],
      "bundle.js",
    )!;
    const consumer = new SourceMapConsumer(composed);
    expect(consumer.originalPositionFor({ line: 1, column: 0 }).source).toBe(
      "a.ts",
    );
    expect(consumer.originalPositionFor({ line: 1, column: 0 }).line).toBe(10);
    const b = consumer.originalPositionFor({ line: 4, column: 0 });
    expect(b.source).toBe("b.ts");
    expect(b.line).toBe(20);
  });

  it("applies startLineOffset to the first module (eval wrapper line)", () => {
    const mapA = buildMap("a.js", [{ gen: 1, src: "a.ts", orig: 10 }]);
    // startLineOffset 1 mirrors the `(function (...) {` wrapper: the body's
    // gen line 1 maps to bundle line 2.
    const composed = composeBundleSourceMap(
      [{ body: "x", map: mapA }],
      "m.js",
      1,
    )!;
    const consumer = new SourceMapConsumer(composed);
    expect(consumer.originalPositionFor({ line: 2, column: 0 }).source).toBe(
      "a.ts",
    );
    expect(consumer.originalPositionFor({ line: 2, column: 0 }).line).toBe(10);
  });

  it("returns undefined when no module has a map", () => {
    expect(composeBundleSourceMap([{ body: "x" }], "m.js")).toBe(undefined);
  });

  it("overrides the recorded source path when `source` is given", () => {
    // Compiler maps record only the basename; the override rewrites it to the
    // full module path so resolved coordinates match the verified-source set.
    const mapA = buildMap("a.js", [{ gen: 1, src: "main.tsx", orig: 10 }]);
    const composed = composeBundleSourceMap(
      [{ body: "x", map: mapA, source: "/id/dir/main.tsx" }],
      "m.js",
    )!;
    const consumer = new SourceMapConsumer(composed);
    const pos = consumer.originalPositionFor({ line: 1, column: 0 });
    expect(pos.source).toBe("/id/dir/main.tsx");
    expect(pos.line).toBe(10);
  });

  it("preserves sourcesContent under the overridden source name", () => {
    const g = new SourceMapGenerator({ file: "a.js" });
    g.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 10, column: 0 },
      source: "main.tsx",
    });
    g.setSourceContent("main.tsx", "const authored = 1;");
    const mapA = JSON.parse(g.toString());
    const composed = composeBundleSourceMap(
      [{ body: "x", map: mapA, source: "/id/dir/main.tsx" }],
      "m.js",
    )!;
    // Content must be reachable under the OVERRIDDEN name (what the mappings
    // now point at), so DevTools can display the authored source.
    expect(
      composed.sourcesContent?.[composed.sources.indexOf("/id/dir/main.tsx")],
    )
      .toBe("const authored = 1;");
  });
});

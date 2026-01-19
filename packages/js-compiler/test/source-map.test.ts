import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  SourceMapParser,
  TypeScriptCompiler,
} from "../mod.ts";
import { StaticCacheFS } from "@commontools/static";
import { SourceMapConsumer } from "source-map-js";

const staticCache = new StaticCacheFS();
const types = await getTypeScriptEnvironmentTypes(staticCache);
types["commontools.d.ts"] = await staticCache.getText(
  "types/commontools.d.ts",
);

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

    const compiled = await compiler.resolveAndCompile(program, {
      filename: "test-error.js",
    });

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

    // Parse the source map
    if (compiled.sourceMap) {
      const consumer = new SourceMapConsumer(compiled.sourceMap);

      console.log("\n=== Sample Position Mappings ===");
      // Check what various line/column positions map to
      for (let line = 1; line <= 10; line++) {
        for (const col of [0, 10, 20, 30]) {
          const pos = consumer.originalPositionFor({ line, column: col });
          if (pos.source !== null) {
            console.log(
              `Line ${line}, Col ${col} -> ${pos.source}:${pos.line}:${pos.column} (name: ${pos.name})`,
            );
          }
        }
      }
    }
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

    const compiled = await compiler.resolveAndCompile(program, {
      filename: "test-error.js",
    });

    const parser = new SourceMapParser();
    parser.load("test-error.js", compiled.sourceMap!);

    // Simulate executing the compiled code and getting an error
    try {
      const fn = eval(compiled.js);
      const exports = fn({});
      exports.test();
    } catch (e: any) {
      console.log("\n=== Raw Error Stack ===");
      console.log(e.stack);

      const parsed = parser.parse(e.stack);
      console.log("\n=== Parsed (Source Mapped) Stack ===");
      console.log(parsed);
    }
  });

  it("handles bundler line prepending correctly", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
// Line 2 in original source
function userCode() {
  // Line 4 in original source
  throw new Error("user error"); // Line 5 in original source
}

export default function() {
  userCode(); // Line 9 in original source
}
`,
    });

    const compiled = await compiler.resolveAndCompile(program, {
      filename: "bundle.js",
    });

    // Count lines in the compiled output
    const lines = compiled.js.split("\n");
    console.log("\n=== Compiled Bundle Line Count ===");
    console.log(`Total lines: ${lines.length}`);
    console.log("\n=== First 10 lines ===");
    lines.slice(0, 10).forEach((line, i) => {
      console.log(
        `${i + 1}: ${line.slice(0, 100)}${line.length > 100 ? "..." : ""}`,
      );
    });

    // Check source map mappings for various positions
    const consumer = new SourceMapConsumer(compiled.sourceMap!);
    console.log("\n=== Source Map Mappings for Lines 1-5 ===");
    for (let line = 1; line <= 5; line++) {
      // Try different columns on each line
      for (const col of [0, 50, 100, 150, 200]) {
        const pos = consumer.originalPositionFor({ line, column: col });
        if (pos.source !== null) {
          console.log(
            `Compiled L${line}:${col} -> Original ${pos.source}:${pos.line}:${pos.column}`,
          );
        }
      }
    }
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

    const compiled = await compiler.resolveAndCompile(program, {
      filename: "known-line.js",
    });

    const parser = new SourceMapParser();
    parser.load("known-line.js", compiled.sourceMap!);

    try {
      const fn = eval(compiled.js);
      const exports = fn({});
      // Call the default export which should throw
      exports.default();
    } catch (e: any) {
      const parsed = parser.parse(e.stack);
      console.log("\n=== Stack for known line 6 error ===");
      console.log("Raw:", e.stack);
      console.log("\nParsed:", parsed);

      // The error should mention line 6 from main.tsx
      // Note: source map has "main.tsx" not "/main.tsx"
      expect(parsed).toContain("main.tsx");
      expect(parsed).toContain(":6:");
    }
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

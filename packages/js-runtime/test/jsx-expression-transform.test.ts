import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getTypeScriptEnvironmentTypes, TypeScriptCompiler } from "../mod.ts";
import { cache } from "@commontools/static";

const types = await getTypeScriptEnvironmentTypes();
const commontools = await cache.getText("types/commontools.d.ts");
const typeLibs = { ...types, commontools };

describe("JSX Expression Transformer", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("transforms JSX expressions with OpaqueRef", async () => {
    // Since this test needs to check the compiled JS output,
    // we'll use the compiler directly with the fixture
    const inputContent = await Deno.readTextFile("test/fixtures/jsx-expressions/recipe-with-cells.input.tsx");
    
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: inputContent,
        },
        {
          name: "commontools.d.ts",
          contents: commontools,
        },
      ],
    };

    const compiled = compiler.compile(program, {
      runtimeModules: ["commontools"],
    });

    // Recipe call should NOT be wrapped in derive
    expect(compiled.js).toContain(
      "exports.default = (0, commontools_1.recipe)(model, model, (cell)",
    );

    // JSX expressions should be wrapped in derive
    expect(compiled.js).toContain(
      "commontools_1.derive(cell.value, _v1 => _v1 + 1)",
    );
    expect(compiled.js).toContain(
      "commontools_1.derive(cell.value, _v1 => _v1 * 2)",
    );
  });
});
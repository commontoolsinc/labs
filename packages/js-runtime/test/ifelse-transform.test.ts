import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { transformFixture } from "./test-utils.ts";
import { getTypeScriptEnvironmentTypes, TypeScriptCompiler } from "../mod.ts";
import { cache } from "@commontools/static";

const types = await getTypeScriptEnvironmentTypes();
const commontools = await cache.getText("types/commontools.d.ts");
const typeLibs = { ...types, commontools };

describe("IfElse Transformer", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("transforms ternary with OpaqueRef and adds ifElse import", async () => {
    // Since this test needs to check the compiled JS output (not just transformed TS),
    // we'll use the compiler directly with the fixture
    const inputContent = await Deno.readTextFile("test/fixtures/transformations/ifelse/odd-even-ternary.input.ts");
    
    const program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
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

    // Ternary should be transformed to ifElse
    expect(compiled.js).toContain('commontools_1.ifElse(odd, "odd", "even")');
  });
});
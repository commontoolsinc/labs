import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getTypeScriptEnvironmentTypes, TypeScriptCompiler } from "../mod.ts";
import { cache } from "@commontools/static";

const types = await getTypeScriptEnvironmentTypes();
const commontools = await cache.getText("types/commontools.d.ts");
const typeLibs = { ...types, commontools };

describe("Recipe Transformation", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("does not wrap handler calls or ifElse in derive", async () => {
    // Load the fixture
    const inputContent = await Deno.readTextFile("test/fixtures/recipe-transform/handler-ifelse-no-wrap.input.tsx");
    
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

    // Handler calls should not be wrapped in derive
    expect(compiled.js).not.toContain(
      "commontools_1.derive(cell, _v1 => adder",
    );

    // ifElse should not be wrapped in derive
    expect(compiled.js).not.toContain("commontools_1.derive({");
    expect(compiled.js).toContain("(0, commontools_1.ifElse)(pending");
  });
});
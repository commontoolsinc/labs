import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { 
  getTypeScriptEnvironmentTypes,
  TypeScriptCompiler,
} from "../mod.ts";
import { cache } from "@commontools/static";

const types = await getTypeScriptEnvironmentTypes();
const commontools = await cache.getText("types/commontools.d.ts");
const typeLibs = { ...types, commontools };

describe("IfElse Transformer", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("transforms ternary with OpaqueRef and adds ifElse import", () => {
    const program = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: `/// <cts-enable />
import { derive, h, handler, NAME, recipe, schema, str, UI } from "commontools";

const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

export default recipe(model, model, (cell) => {
  const odd = derive(cell.value, (value) => value % 2);
  const label = odd ? "odd" : "even";

  return {
    [UI]: label,
    value: cell.value,
  };
});
`,
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
    expect(compiled.js).toContain('exports.default = (0, commontools_1.recipe)(model, model, (cell)');
    
    // Ternary should be transformed to ifElse
    expect(compiled.js).toContain('commontools_1.ifElse(odd, "odd", "even")');
  });
});
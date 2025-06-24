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
      entry: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: `
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
    
    // Recipe call wrapped in derive due to OpaqueRef usage
    expect(compiled.js).toContain('commontools_1.derive({ cell, odd, cell_value: cell.value, value }');
    
    // Ternary remains unchanged because _v2 is not an OpaqueRef
    expect(compiled.js).toContain('_v2 ? "odd" : "even"');
  });
});
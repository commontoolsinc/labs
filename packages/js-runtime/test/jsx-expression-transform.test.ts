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

describe("JSX Expression Transformer", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("transforms JSX expressions with OpaqueRef", () => {
    const program = {
      entry: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `
import { derive, h, recipe, schema, UI } from "commontools";

const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

export default recipe(model, model, (cell) => {
  return {
    [UI]: (
      <div>
        <p>Current value: {cell.value}</p>
        <p>Next value: {cell.value + 1}</p>
        <p>Double: {cell.value * 2}</p>
      </div>
    ),
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
    expect(compiled.js).toContain('commontools_1.derive({ cell, cell_value: cell.value, value }');
    
    // JSX expressions use pre-extracted values
    expect(compiled.js).toContain('_v2 + 1');
    expect(compiled.js).toContain('_v2 * 2');
  });
});
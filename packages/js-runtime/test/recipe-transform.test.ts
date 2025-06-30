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

describe("Recipe Transformation", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("does not wrap handler calls or ifElse in derive", () => {
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `
import {
  derive,
  generateObject,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  recipe,
  str,
  toSchema,
  UI,
} from "commontools";

interface InputState {
  number: number; // @asCell
}

interface OutputState {
  title: string;
  story: string;
}

const inputSchema = toSchema<InputState>({
  default: { number: 0 },
});

const outputSchema = toSchema<OutputState>();

const adder = handler({}, inputSchema, (_, state) => {
  state.number.set(state.number.get() + 1);
});

const generatePrompt = lift(({ number }: { number: number }) => {
  return {
    prompt: \`Tell me about the number \${number}\`,
    schema: outputSchema,
  };
});

export default recipe(inputSchema, outputSchema, (cell) => {
  const { result: object, pending } = generateObject<OutputState>(
    generatePrompt({ number: cell.number }),
  );

  return {
    [NAME]: str\`Number Story: \${object?.title || "Loading..."}\`,
    [UI]: (
      <div>
        <ct-button onClick={adder({ number: cell.number })}>
          Current number: {cell.number} (click to increment)
        </ct-button>
        {ifElse(
          pending,
          <p>Generating story...</p>,
          <div>
            <h1>{object?.title}</h1>
            <p>{object?.story}</p>
          </div>,
        )}
      </div>
    ),
    number: cell.number,
    ...object,
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
    
    console.log("=== COMPILED OUTPUT ===");
    console.log(compiled.js);
    console.log("=== END OUTPUT ===");
    
    // Handler calls should not be wrapped in derive
    expect(compiled.js).not.toContain('commontools_1.derive(cell, _v1 => adder');
    
    // ifElse should not be wrapped in derive
    expect(compiled.js).not.toContain('commontools_1.derive({');
    expect(compiled.js).toContain('(0, commontools_1.ifElse)(pending');
  });
});
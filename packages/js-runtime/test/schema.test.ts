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

describe("Schema Transformer", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("transforms toSchema<T>() with simple interface", () => {
    const program = {
      entry: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: `
import { toSchema, JSONSchema } from "commontools";

interface User {
  name: string;
  age: number;
}

const userSchema = toSchema<User>();
export { userSchema };
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
    
    // Check that toSchema was transformed
    expect(compiled.js).not.toContain('toSchema');
    expect(compiled.js).toContain('type: "object"');
    expect(compiled.js).toContain('type: "string"');
    expect(compiled.js).toContain('type: "number"');
    expect(compiled.js).toContain('properties:');
    expect(compiled.js).toContain('name:');
    expect(compiled.js).toContain('age:');
    expect(compiled.js).toContain('required: ["name", "age"]');
  });

  it("transforms toSchema<T>() with asCell comment", () => {
    const program = {
      entry: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: `
import { toSchema } from "commontools";

interface State {
  count: number; // @asCell
  label: string;
}

const stateSchema = toSchema<State>();
export { stateSchema };
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
    
    // Check that asCell was detected
    expect(compiled.js).toContain('asCell: true');
    expect(compiled.js).toContain('count:');
    expect(compiled.js).not.toContain('@asCell');
  });

  it("transforms toSchema<T>() with options", () => {
    const program = {
      entry: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: `
import { toSchema } from "commontools";

interface Config {
  value: number;
}

const configSchema = toSchema<Config>({
  default: { value: 42 },
  description: "Configuration schema"
});
export { configSchema };
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
    
    // Check that options were merged
    expect(compiled.js).toContain('default: {');
    expect(compiled.js).toContain('value: 42');
    expect(compiled.js).toContain('description: "Configuration schema"');
  });

  it("transforms toSchema<T>() with arrays and optional properties", () => {
    const program = {
      entry: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: `
import { toSchema } from "commontools";

interface TodoItem {
  title: string;
  done?: boolean;
  tags: string[];
}

const todoSchema = toSchema<TodoItem>();
export { todoSchema };
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
    
    // Check array handling
    expect(compiled.js).toContain('tags:');
    expect(compiled.js).toContain('type: "array"');
    expect(compiled.js).toContain('type: "string"');
    
    // Check required - should not include "done" in required array
    expect(compiled.js).toContain('required:');
    expect(compiled.js).toContain('"title"');
    expect(compiled.js).toContain('"tags"');
  });

  it("works with OpaqueRef transformer", () => {
    const program = {
      entry: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `
import { derive, h, recipe, toSchema, UI } from "commontools";

interface State {
  value: number; // @asCell
}

const model = toSchema<State>({
  default: { value: 0 },
});

export default recipe(model, model, (cell) => {
  const doubled = derive(cell.value, (v) => v * 2);
  
  return {
    [UI]: (
      <div>
        <p>Value: {cell.value}</p>
        <p>Doubled: {doubled}</p>
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
    
    // Check that both transformers worked
    expect(compiled.js).not.toContain('toSchema');
    expect(compiled.js).toContain('type: "object"');
    expect(compiled.js).toContain('asCell: true');
    expect(compiled.js).toContain('commontools_1.derive');
    expect(compiled.js).toContain('(v) => v * 2');
  });
});
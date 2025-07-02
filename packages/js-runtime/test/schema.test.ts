import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { getTypeScriptEnvironmentTypes, TypeScriptCompiler } from "../mod.ts";
import { compareFixtureTransformation } from "./test-utils.ts";
import { cache } from "@commontools/static";

const types = await getTypeScriptEnvironmentTypes();
const commontools = await cache.getText("types/commontools.d.ts");
const typeLibs = { ...types, commontools };

describe("Schema Transformer", () => {
  const compiler = new TypeScriptCompiler(typeLibs);

  it("transforms toSchema<T>() with simple interface", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/simple-interface.input.ts",
      "schema-transform/simple-interface.expected.ts",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms toSchema<T>() with Stream<T> type", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/stream-type.input.ts",
      "schema-transform/stream-type.expected.ts",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms toSchema<T>() with options", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/with-options.input.ts",
      "schema-transform/with-options.expected.ts",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms toSchema<T>() with arrays and optional properties", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/arrays-optional.input.ts",
      "schema-transform/arrays-optional.expected.ts",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms toSchema<T>() with Cell<T> type", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/cell-type.input.ts",
      "schema-transform/cell-type.expected.ts",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("works with OpaqueRef transformer", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/with-opaque-ref.input.tsx",
      "schema-transform/with-opaque-ref.expected.tsx",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms complex types with toSchema", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/type-to-schema.input.ts",
      "schema-transform/type-to-schema.expected.ts",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms recipe with complex types and inheritance", async () => {
    const result = await compareFixtureTransformation(
      "schema-transform/recipe-with-types.input.tsx",
      "schema-transform/recipe-with-types.expected.tsx",
      { types: { "commontools.d.ts": commontools }, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("skips transformation without /// <cts-enable /> directive", async () => {
    // This test needs to check compiled output since we're verifying
    // that the transformation didn't happen
    const inputContent = await Deno.readTextFile("fixtures/schema-transform/no-directive.input.ts");
    
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

    // Should NOT transform without the directive
    expect(compiled.js).toContain("commontools_1.toSchema)(");
    expect(compiled.js).not.toContain('"type":"object"');
    expect(compiled.js).not.toContain('"properties"');
    expect(compiled.js).not.toContain("satisfies");
  });
});
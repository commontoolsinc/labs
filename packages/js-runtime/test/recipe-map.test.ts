import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { transformSource } from "./test-utils.ts";
import { getTypeScriptEnvironmentTypes } from "../mod.ts";
import { StaticCache } from "@commontools/static";

describe("Recipe with Array Map", () => {
  it("transforms recipe with array.map in JSX", async () => {
    const source = `
/// <cts-enable />
import { Cell, h, recipe, UI } from "commontools";

export default recipe<{ items: string[] }>("Test Recipe", ({ items }) => {
  return {
    [UI]: (
      <div>
        {items.map((item, index) => (
          <div key={index}>{item}</div>
        ))}
      </div>
    ),
    items
  };
});
`;

    const envTypes = await getTypeScriptEnvironmentTypes(new StaticCache());
    const commontools = envTypes["commontools.d.ts"] || "";

    const result = await transformSource(source, {
      types: { "commontools.d.ts": commontools },
      applySchemaTransformer: true,
    });

    // The transformation should work correctly
    assertStringIncludes(result, "items.map((item, index)");
    assertStringIncludes(result, "{item}");
    
    // Schema should be generated
    assertStringIncludes(result, "type: \"array\"");
    assertStringIncludes(result, "items: {");
  });

  it("handles nested variable names in map", async () => {
    const source = `
/// <cts-enable />
import { h, recipe, UI } from "commontools";

export default recipe<{ values: string[] }>("Values", ({ values }) => {
  return {
    [UI]: (
      <div>
        {values.map((value, index) => (
          <span>{index}: {value}</span>
        ))}
      </div>
    ),
    values
  };
});
`;

    const envTypes = await getTypeScriptEnvironmentTypes(new StaticCache());
    const commontools = envTypes["commontools.d.ts"] || "";

    const result = await transformSource(source, {
      types: { "commontools.d.ts": commontools },
      applySchemaTransformer: true,
    });

    // Check that the variable names are preserved
    assertStringIncludes(result, "values.map((value, index)");
    assertStringIncludes(result, "{value}");
    assertStringIncludes(result, "{index}");
  });
});
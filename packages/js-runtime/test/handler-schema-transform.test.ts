import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { compareFixtureTransformation } from "./test-utils.ts";
import { cache } from "@commontools/static";

const commontools = await cache.getText("types/commontools.d.ts");

describe("Handler Schema Transformation", () => {
  const types = { "commontools.d.ts": commontools };

  it("transforms handler<Event, State>() to include JSON schemas", async () => {
    const result = await compareFixtureTransformation(
      "handler-schema/simple-handler.input.ts",
      "handler-schema/simple-handler.expected.ts",
      { types, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms handler with complex nested types", async () => {
    const result = await compareFixtureTransformation(
      "handler-schema/complex-nested-types.input.ts",
      "handler-schema/complex-nested-types.expected.ts",
      { types, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("preserves handler without type parameters", async () => {
    const result = await compareFixtureTransformation(
      "handler-schema/preserve-explicit-schemas.input.ts",
      "handler-schema/preserve-explicit-schemas.expected.ts",
      { types, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("transforms handler with Date and Map types", async () => {
    const result = await compareFixtureTransformation(
      "handler-schema/date-and-map-types.input.ts",
      "handler-schema/date-and-map-types.expected.ts",
      { types, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });

  it("shows complete transformation from handler<T,U> to handler with schemas", async () => {
    const result = await compareFixtureTransformation(
      "handler-schema/complete-transformation.input.ts",
      "handler-schema/complete-transformation.expected.ts",
      { types, applySchemaTransformer: true }
    );
    
    expect(result.matches).toBe(true);
  });
});
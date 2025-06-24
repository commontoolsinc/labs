import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { transformFixture, compareFixtureTransformation } from "./test-utils.ts";
import { cache } from "@commontools/static";

const commonToolsTypes = await cache.getText("types/commontools.d.ts");

describe("OpaqueRef Transformer with Fixtures", () => {
  const types = { "commontools.d.ts": commonToolsTypes };

  describe("Ternary Transformations", () => {
    it("handles nested ternary expressions", async () => {
      const result = await compareFixtureTransformation(
        "opaque-refs/nested-ternary.input.ts",
        "opaque-refs/nested-ternary.expected.ts",
        { types }
      );
      
      expect(result.matches).toBe(true);
      if (!result.matches) {
        console.log("Expected:", result.expected);
        console.log("Actual:", result.actual);
      }
    });
  });

  describe("Binary Expression Transformations", () => {
    it("transforms binary expressions with OpaqueRef", async () => {
      const result = await compareFixtureTransformation(
        "opaque-refs/binary-expressions.input.ts",
        "opaque-refs/binary-expressions.expected.ts",
        { types }
      );
      
      expect(result.matches).toBe(true);
    });

    it("handles multiple OpaqueRefs in one expression", async () => {
      const result = await compareFixtureTransformation(
        "opaque-refs/multiple-refs.input.ts",
        "opaque-refs/multiple-refs.expected.ts",
        { types }
      );
      
      expect(result.matches).toBe(true);
    });

    it("handles binary expression with ternary using OpaqueRef", async () => {
      const result = await compareFixtureTransformation(
        "opaque-refs/binary-with-ternary.input.ts",
        "opaque-refs/binary-with-ternary.expected.ts",
        { types }
      );
      
      expect(result.matches).toBe(true);
    });

    it("transforms array elements with OpaqueRef operations independently", async () => {
      const result = await compareFixtureTransformation(
        "opaque-refs/array-with-opaque-operations.input.ts",
        "opaque-refs/array-with-opaque-operations.expected.ts",
        { types }
      );
      
      expect(result.matches).toBe(true);
      if (!result.matches) {
        console.log("Expected:", result.expected);
        console.log("Actual:", result.actual);
      }
    });

    it("transforms object literal properties with OpaqueRef operations independently", async () => {
      const result = await compareFixtureTransformation(
        "opaque-refs/object-literal-operations.input.ts",
        "opaque-refs/object-literal-operations.expected.ts",
        { types }
      );
      
      expect(result.matches).toBe(true);
    });

    it("transforms ternary with comparison operation", async () => {
      // Tests that (opaque > 5 ? 1 : 2) becomes ifElse(derive(opaque, _v1 => _v1 > 5), 1, 2)
      const result = await compareFixtureTransformation(
        "opaque-refs/ternary-with-comparison.input.ts",
        "opaque-refs/ternary-with-comparison.expected.ts",
        { types }
      );
      
      expect(result.matches).toBe(true);
    });
  });

  describe("Function Call Transformations", () => {
    it("transforms function calls with OpaqueRef arguments", async () => {
      const result = await compareFixtureTransformation(
        "opaque-refs/function-calls-with-opaque.input.ts",
        "opaque-refs/function-calls-with-opaque.expected.ts",
        { types }
      );
      
      if (!result.matches) {
        console.log("Expected:", result.expected);
        console.log("Actual:", result.actual);
      }
      expect(result.matches).toBe(true);
    });
  });

  describe("Using fixtures with custom assertions", () => {
    it("transforms binary expressions correctly", async () => {
      const transformed = await transformFixture(
        "opaque-refs/binary-expressions.input.ts",
        { types }
      );
      
      // Custom assertions
      expect(transformed).toContain("commontools_1.derive");
      expect(transformed).toContain("_v1 => _v1 + 1");
      expect(transformed).toContain("_v1 => _v1 * 2");
      expect(transformed).toContain("_v1 => _v1 - 1");
      expect(transformed).not.toContain("count + 1");
    });
  });
});
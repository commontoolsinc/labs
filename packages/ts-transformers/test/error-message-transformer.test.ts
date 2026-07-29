import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CompositeDiagnosticTransformer,
  ReactiveErrorTransformer,
} from "../src/diagnostics/mod.ts";

describe("ReactiveErrorTransformer", () => {
  it("transforms .get() on OpaqueCell error to clear message", () => {
    const transformer = new ReactiveErrorTransformer();
    const originalMessage =
      "Property 'get' does not exist on type 'OpaqueCell<number> & number'.";

    const result = transformer.transform(originalMessage);

    expect(result).not.toBeNull();
    expect(result).toContain("Unnecessary .get() call");
    expect(result).toContain("remove .get()");
    expect(result).not.toContain("OpaqueCell"); // Original error suppressed
  });

  it("includes original error in verbose mode", () => {
    const transformer = new ReactiveErrorTransformer({ verbose: true });
    const originalMessage =
      "Property 'get' does not exist on type 'OpaqueCell<number> & number'.";

    const result = transformer.transform(originalMessage);

    expect(result).not.toBeNull();
    expect(result).toContain("Unnecessary .get() call");
    expect(result).toContain("Original TypeScript error:");
    expect(result).toContain("OpaqueCell<number>"); // Original included
  });

  it("returns null for unrelated errors", () => {
    const transformer = new ReactiveErrorTransformer();
    const unrelatedMessage =
      "Type 'string' is not assignable to type 'number'.";

    const result = transformer.transform(unrelatedMessage);

    expect(result).toBeNull();
  });

  it("handles complex OpaqueCell types", () => {
    const transformer = new ReactiveErrorTransformer();
    const complexMessage =
      "Property 'get' does not exist on type 'OpaqueCell<{ items: string[]; count: number }> & { items: string[]; count: number }'.";

    const result = transformer.transform(complexMessage);

    expect(result).not.toBeNull();
    expect(result).toContain("Unnecessary .get() call");
  });

  it("explains legacy AsyncResult property access", () => {
    const transformer = new ReactiveErrorTransformer();

    for (const property of ["result", "pending", "error", "partial"]) {
      const result = transformer.transform(
        `Property '${property}' does not exist on type 'AsyncResult<Repo>'.`,
      );
      expect(result).not.toBeNull();
      expect(result).toContain("resultOf(request)");
      expect(result).toContain("isPending(request)");
      expect(result).toContain("hasError(request)");
      expect(result).toContain("partialResultOf(request)");
    }
  });
});

describe("CompositeDiagnosticTransformer", () => {
  it("returns first successful transformation", () => {
    const transformer1 = new ReactiveErrorTransformer();
    const transformer2 = {
      transform: (msg: string) =>
        msg.includes("foo") ? "transformed foo" : null,
    };
    const composite = new CompositeDiagnosticTransformer([
      transformer1,
      transformer2,
    ]);

    // First transformer matches
    const opaqueResult = composite.transform(
      "Property 'get' does not exist on type 'OpaqueCell<number> & number'.",
    );
    expect(opaqueResult).toContain("Unnecessary .get() call");

    // Second transformer matches
    const fooResult = composite.transform("some foo error");
    expect(fooResult).toBe("transformed foo");

    // Neither matches
    const noMatch = composite.transform("unrelated error");
    expect(noMatch).toBeNull();
  });
});

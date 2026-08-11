// Focused coverage guard for the public `toIndentedDebugString` wrapper.
//
// `toIndentedDebugString` is a one-line public function that forwards to the
// module-private `renderDebugString(value, 2)`. This file calls it directly on
// a spread of representative values so the wrapper is exercised on its own,
// independent of whichever larger suite happens to reach it indirectly.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toCompactDebugString, toIndentedDebugString } from "@/value-debug.ts";
import { FabricEpochNsec } from "@/fabric-primitives/FabricEpochNsec.ts";

describe("toIndentedDebugString (direct wrapper coverage)", () => {
  it("returns a non-empty string for a plain nested object", () => {
    const result = toIndentedDebugString({ a: 1, nested: { b: 2 } });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("indents nested object structure with 2 spaces", () => {
    // Two leading spaces before the first key confirm `indent === 2` reached
    // `JSON.stringify`. A deeper key carries four spaces.
    const result = toIndentedDebugString({ a: 1, nested: { b: 2 } });
    expect(result).toContain('\n  "a"');
    expect(result).toContain('\n    "b"');
  });

  it("indents array elements with 2 spaces", () => {
    const result = toIndentedDebugString([1, 2, 3]);
    expect(result).toBe("[\n  1,\n  2,\n  3\n]");
  });

  it("renders a top-level primitive as a bare string", () => {
    expect(toIndentedDebugString(42)).toBe("42");
    expect(toIndentedDebugString("hello")).toBe('"hello"');
    expect(toIndentedDebugString(true)).toBe("true");
    expect(toIndentedDebugString(null)).toBe("null");
  });

  it("delegates with `indent === 2`, matching the equivalent JSON layout", () => {
    // For JSON-native values the wrapper's output equals the two-space
    // `JSON.stringify` of the same value, which is what the private
    // `renderDebugString(value, 2)` produces. This pins the forwarded indent.
    for (const value of [{ a: 1, b: { c: 2 } }, [1, [2, 3]], "x", 7, false]) {
      expect(toIndentedDebugString(value)).toBe(JSON.stringify(value, null, 2));
    }
  });

  it("applies indentation that the compact form omits", () => {
    // The indented and compact wrappers share the same renderer; the only
    // difference is the forwarded indent, so a nested structure must differ.
    const value = { a: 1, nested: { b: 2 } };
    expect(toIndentedDebugString(value)).not.toBe(toCompactDebugString(value));
  });

  it("renders an exotic (non-plain) value without throwing", () => {
    const inst = new FabricEpochNsec(123456789n);
    expect(() => toIndentedDebugString(inst)).not.toThrow();
    expect(toIndentedDebugString(inst)).toBe("/EpochNsec(...)");
  });

  it("renders a circular reference as `<circle>` rather than throwing", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => toIndentedDebugString(a)).not.toThrow();
    expect(toIndentedDebugString(a)).toBe(
      '{\n  "x": 1,\n  "self": <circle>\n}',
    );
  });

  it("falls back to the unrenderable string instead of throwing", () => {
    // The docstring promises a literal fallback string when stringification
    // cannot complete (here, a throwing `toJSON()`).
    const value = {
      toJSON: () => {
        throw new Error("nope");
      },
    };
    expect(() => toIndentedDebugString(value)).not.toThrow();
    expect(toIndentedDebugString(value)).toBe("<unrenderable debug string>");
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { quotedDebugString } from "@/codec-common/quotedDebugString.ts";

describe("quotedDebugString()", () => {
  it("returns the compact rendering as a backtick-quoted code span", () => {
    expect(quotedDebugString({ a: [1, "x"] })).toBe('`{a:[1,"x"]}`');
  });

  it("returns a rendering cut to fifty characters, ellipsis included", () => {
    const value = { text: "x".repeat(100) };
    const quoted = quotedDebugString(value);
    expect(quoted).toBe("`" + quoted.slice(1, -1) + "`");
    expect(quoted.slice(1, -1).length).toBe(50);
    expect(quoted.endsWith("...`")).toBe(true);
  });

  it("returns a quoted rendering for a value the renderer cannot read", () => {
    const value = {
      get boom(): number {
        throw new Error("nope");
      },
    };
    expect(quotedDebugString(value)).toBe(
      '`{boom:/unconvertible("nope")}`',
    );
  });
});

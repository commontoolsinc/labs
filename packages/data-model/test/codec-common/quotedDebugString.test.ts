import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { quotedDebugString } from "@/codec-common/quotedDebugString.ts";
import { toCompactDebugString } from "@/value-debug.ts";

describe("quotedDebugString()", () => {
  it("returns the compact rendering as a backtick-quoted code span", () => {
    expect(quotedDebugString({ a: [1, "x"] })).toBe('`{a:[1,"x"]}`');
  });

  it("returns a rendering cut to fifty characters, ellipsis included", () => {
    const value = { text: "x".repeat(100) };
    const whole = toCompactDebugString(value);
    expect(whole.length).toBeGreaterThan(50);
    expect(quotedDebugString(value)).toBe(`\`${whole.slice(0, 47)}...\``);
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

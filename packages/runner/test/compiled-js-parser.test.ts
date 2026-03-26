import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { findTopLevelEquals } from "../src/sandbox/compiled-js-parser.ts";

describe("findTopLevelEquals()", () => {
  it("ignores compound assignments at the top level", () => {
    const source = "exports.foo += 1";

    expect(findTopLevelEquals(source, 0, source.length)).toBeUndefined();
  });

  it("still finds direct assignments before nested compound assignments", () => {
    const source = "foo = bar += 1";

    expect(findTopLevelEquals(source, 0, source.length)).toBe(4);
  });
});

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  findTopLevelEquals,
  trimRange,
  tryParseDefineCall,
} from "../src/sandbox/compiled-js-parser.ts";

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

describe("trimRange()", () => {
  it("trims trailing block comments", () => {
    const source = "value /* trailing comment */";

    expect(trimRange(source, 0, source.length)).toEqual({
      start: 0,
      end: 5,
    });
  });

  it("trims trailing line comments", () => {
    const source =
      "value\n//# sourceMappingURL=data:foo\n//# sourceURL=bar.js\n";

    expect(trimRange(source, 0, source.length)).toEqual({
      start: 0,
      end: 5,
    });
  });

  it("leaves already-trimmed plain expressions unchanged", () => {
    const source = "exports.default";

    expect(trimRange(source, 0, source.length)).toEqual({
      start: 0,
      end: source.length,
    });
  });
});

describe("tryParseDefineCall()", () => {
  it("parses a canonical AMD define statement", () => {
    const source =
      `define("index", ["require", "exports"], function (require, exports) {
        "use strict";
        exports.default = 1;
      });`;

    const defineCall = tryParseDefineCall(source, {
      start: 0,
      end: source.length,
    });

    expect(defineCall).toBeDefined();
    expect(defineCall?.moduleId).toBe("index");
    expect(defineCall?.dependencies).toEqual(["require", "exports"]);
    expect(defineCall?.factory.params).toEqual(["require", "exports"]);
    expect(defineCall?.factory.body.statements).toHaveLength(2);
  });
});

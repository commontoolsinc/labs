import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CompiledJsParseError,
  findTopLevelArrow,
  findTopLevelEquals,
  isStringLiteralRange,
  locationFromOffset,
  parseCompiledBundleSource,
  parseFunctionText,
  parseStringLiteralValue,
  splitTopLevelCommaList,
  stripJsTrivia,
  stripWholeParentheses,
  trimRange,
  tryParseCallExpression,
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

describe("parseCompiledBundleSource()", () => {
  it("parses wrapped AMD define calls and preserves factory statements", () => {
    const source = `(function () {
      define("index", ["require", "exports", "./dep"], function named(require, exports, dep) {
        "use strict";
        if (dep.ready) {
          exports.value = dep.value;
        } else {
          exports.value = /a,b/.test("a,b");
        }
      });
      const ignored = call(1, { nested: [2, 3] });
    });`;

    const parsed = parseCompiledBundleSource(source);

    expect(parsed.defineCalls).toHaveLength(1);
    expect(parsed.body.statements).toHaveLength(2);
    expect(parsed.defineCalls[0].moduleId).toBe("index");
    expect(parsed.defineCalls[0].dependencies).toEqual([
      "require",
      "exports",
      "./dep",
    ]);
    expect(parsed.defineCalls[0].factory.params).toEqual([
      "require",
      "exports",
      "dep",
    ]);
    expect(parsed.defineCalls[0].factory.body.statements).toHaveLength(2);
  });

  it("throws a parse error for empty bundles", () => {
    expect(() => parseCompiledBundleSource("  ")).toThrow(
      CompiledJsParseError,
    );
  });
});

describe("parseFunctionText()", () => {
  it("parses async function expressions with defaulted parameters", () => {
    const source = `async function (first = 1, second) {
      class Local {}
      return \`${"${first + second}"}\`;
    }`;

    const parsed = parseFunctionText(source, 0, source.length);

    expect(parsed.params).toEqual(["first", "second"]);
    expect(parsed.body.statements).toHaveLength(2);
  });

  it("parses arrow functions with block bodies", () => {
    const source = `(value, other) => {
      return value ? other : "fallback";
    }`;

    const parsed = parseFunctionText(source, 0, source.length);

    expect(parsed.params).toEqual(["value", "other"]);
    expect(parsed.body.statements).toHaveLength(1);
  });

  it("rejects destructured parameters", () => {
    const source = `({ value }) => { return value; }`;

    expect(() => parseFunctionText(source, 0, source.length)).toThrow(
      "Factory parameters must be simple identifiers",
    );
  });

  it("rejects arrow expression bodies", () => {
    const source = `value => value + 1`;

    expect(() => parseFunctionText(source, 0, source.length)).toThrow(
      "Expected '{'",
    );
  });
});

describe("scanner helpers", () => {
  it("strips trivia while preserving strings, regexes, and templates", () => {
    const source =
      `  // leading\nfoo /* inner */ + /a\\/[b]/g.test("a/b") + \`x${"${1 + /z/.test(y)}"}\` // trailing`;

    expect(stripJsTrivia(source)).toBe(
      `foo+/a\\/[b]/g.test("a/b")+\`x${"${1 + /z/.test(y)}"}\``,
    );
  });

  it("splits comma lists without splitting nested structures", () => {
    const source =
      `first, call(1, [2, 3]), { nested: /a,b/g }, \`hi, ${"${name}"}\``;

    const parts = splitTopLevelCommaList(source, 0, source.length)
      .map((range) => source.slice(range.start, range.end));

    expect(parts).toEqual([
      "first",
      "call(1, [2, 3])",
      "{ nested: /a,b/g }",
      `\`hi, ${"${name}"}\``,
    ]);
  });

  it("parses call expressions with nested arguments", () => {
    const source = `outer(inner(1, 2), { ok: true }, /a,b/g);`;

    const call = tryParseCallExpression(source, 0, source.length);

    expect(call?.callee).toBe("outer");
    expect(call?.args.map((arg) => source.slice(arg.start, arg.end))).toEqual([
      "inner(1, 2)",
      "{ ok: true }",
      "/a,b/g",
    ]);
  });

  it("returns undefined for non-call expressions", () => {
    const source = `value + 1`;

    expect(tryParseCallExpression(source, 0, source.length)).toBeUndefined();
  });

  it("parses escaped string literal values", () => {
    const source = `"a\\\"b"`;

    expect(parseStringLiteralValue(source, 0, source.length)).toBe('a"b');
  });

  it("recognizes exact string literal ranges", () => {
    const literalWithTrivia = ` /* before */ "a\\\"b" /* after */ `;
    expect(isStringLiteralRange(
      literalWithTrivia,
      0,
      literalWithTrivia.length,
    )).toBe(true);
    const literalWithLineComment = ` /* before */ "a" // after`;
    expect(isStringLiteralRange(
      literalWithLineComment,
      0,
      literalWithLineComment.length,
    )).toBe(true);
    expect(isStringLiteralRange(`"a" + value`, 0, 11)).toBe(false);
    expect(isStringLiteralRange(`"a\n"`, 0, 4)).toBe(false);
    expect(isStringLiteralRange(`"a"b`, 0, 4)).toBe(false);
  });

  it("matches JavaScript string literal token boundaries", () => {
    const escapedClosingQuote = '"' + 'a\\"b' + '"';
    const loneBackslash = '"a\\';
    const escapedBackslash = '"' + "a" + "\\\\" + '"';
    const unicodeEscape = '"' + "\\u0061" + '"';
    const adjacentStrings = '"a""b"';

    expect(isStringLiteralRange(
      escapedClosingQuote,
      0,
      escapedClosingQuote.length,
    )).toBe(true);
    expect(isStringLiteralRange(
      loneBackslash,
      0,
      loneBackslash.length,
    )).toBe(false);
    expect(isStringLiteralRange(
      escapedBackslash,
      0,
      escapedBackslash.length,
    )).toBe(true);
    expect(isStringLiteralRange(
      unicodeEscape,
      0,
      unicodeEscape.length,
    )).toBe(true);
    expect(isStringLiteralRange(
      adjacentStrings,
      0,
      adjacentStrings.length,
    )).toBe(false);

    expect(() => new Function(`return ${escapedClosingQuote};`)).not.toThrow();
    expect(() => new Function(`return ${loneBackslash};`)).toThrow();
    expect(() => new Function(`return ${escapedBackslash};`)).not.toThrow();
    expect(() => new Function(`return ${unicodeEscape};`)).not.toThrow();
    expect(() => new Function(`return ${adjacentStrings};`)).toThrow();
  });

  it("rejects non-string literal values", () => {
    const source = `value`;

    expect(() => parseStringLiteralValue(source, 0, source.length)).toThrow(
      "Expected a string literal",
    );
  });

  it("rejects malformed string literal ranges", () => {
    const source = `"a\n"`;

    expect(() => parseStringLiteralValue(source, 0, source.length)).toThrow(
      "Expected a string literal",
    );
  });

  it("strips only whole parentheses", () => {
    const source = `((value)) + other`;

    expect(stripWholeParentheses(source, 0, source.length)).toEqual({
      start: 0,
      end: source.length,
    });
    expect(stripWholeParentheses(source, 0, "((value))".length)).toEqual({
      start: 2,
      end: 7,
    });
  });

  it("locates top-level arrows and source locations", () => {
    const source = `call(() => 1)\nvalue => ({ ok: true })`;

    expect(findTopLevelArrow(source, 0, source.length)).toBe(20);
    expect(locationFromOffset(source, 20)).toEqual({
      line: 2,
      column: 7,
    });
  });
});

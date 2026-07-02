import { assertEquals } from "@std/assert";

import {
  baselineKeyForNode,
  createNoAsUnknownAsRule,
} from "./no-as-unknown-as.ts";

interface Report {
  node?: unknown;
  range?: readonly [number, number];
  message: string;
}

const source = "const value = foo as unknown" + " as Bar;\n";
const doubleCastText = "as unknown" + " as";
const nestedSource = [
  "implementation = call(",
  `  implementation ${doubleCastText} FactoryInput,`,
  `) ${doubleCastText} Pattern;`,
  "",
].join("\n");

function createContext(reports: Report[], text = source) {
  return {
    filename: new URL("../../fixture.ts", import.meta.url).pathname,
    sourceCode: { text },
    report(report: Report) {
      reports.push(report);
    },
  };
}

function nestedDoubleAssertionNode() {
  const outerStart = nestedSource.indexOf("call(");
  const outerEnd = nestedSource.indexOf("Pattern") + "Pattern".length;
  const expressionEnd = nestedSource.lastIndexOf("unknown") +
    "unknown".length;
  return {
    type: "TSAsExpression",
    range: [outerStart, outerEnd] as const,
    expression: {
      type: "TSAsExpression",
      range: [outerStart, expressionEnd] as const,
      typeAnnotation: {
        type: "TSUnknownKeyword",
        range: [
          nestedSource.lastIndexOf("unknown"),
          expressionEnd,
        ] as const,
      },
    },
    typeAnnotation: {
      type: "TSTypeReference",
      range: [
        nestedSource.indexOf("Pattern"),
        nestedSource.indexOf("Pattern") + "Pattern".length,
      ] as const,
    },
  };
}

function doubleAssertionNode(text = source) {
  return {
    type: "TSAsExpression",
    range: [text.indexOf("foo"), text.indexOf(";")] as const,
    expression: {
      type: "TSAsExpression",
      typeAnnotation: { type: "TSUnknownKeyword" },
    },
  };
}

Deno.test("no-as-unknown-as reports double assertions through unknown", () => {
  const reports: Report[] = [];
  const context = createContext(reports);
  const rule = createNoAsUnknownAsRule(context);

  rule.TSAsExpression(doubleAssertionNode());

  assertEquals(reports.length, 1);
  assertEquals(reports[0]!.range, [18, 31]);
  assertEquals(
    reports[0]!.message,
    "Do not cast a value through unknown before casting it to another type. Add a narrower helper, runtime validation, or a local type that matches the value.",
  );
});

Deno.test("no-as-unknown-as skips baseline entries", () => {
  const reports: Report[] = [];
  const context = createContext(reports);
  const key = baselineKeyForNode(context, doubleAssertionNode());
  const rule = createNoAsUnknownAsRule(context, {
    consume(file, fingerprint) {
      return file === key?.file && fingerprint === key.fingerprint;
    },
  });

  rule.TSAsExpression(doubleAssertionNode());

  assertEquals(reports, []);
});

Deno.test("no-as-unknown-as ignores single assertions through unknown", () => {
  const reports: Report[] = [];
  const context = createContext(reports);
  const rule = createNoAsUnknownAsRule(context);

  rule.TSAsExpression({
    type: "TSAsExpression",
    range: [
      source.indexOf("foo"),
      source.indexOf("unknown") + "unknown".length,
    ],
    expression: {
      type: "Identifier",
      typeAnnotation: { type: "TSUnknownKeyword" },
    },
  });

  assertEquals(reports, []);
});

Deno.test("no-as-unknown-as reports changed assertions at a skipped location", () => {
  const changedSource = source.replace("Bar", "Baz");
  const originalKey = baselineKeyForNode(
    createContext([]),
    doubleAssertionNode(),
  );
  const reports: Report[] = [];
  const context = createContext(reports, changedSource);
  const rule = createNoAsUnknownAsRule(context, {
    consume(file, fingerprint) {
      return file === originalKey?.file &&
        fingerprint === originalKey.fingerprint;
    },
  });

  rule.TSAsExpression(doubleAssertionNode(changedSource));

  assertEquals(reports.length, 1);
});

Deno.test("no-as-unknown-as reports the checked assertion in nested expressions", () => {
  const reports: Report[] = [];
  const context = createContext(reports, nestedSource);
  const rule = createNoAsUnknownAsRule(context);

  rule.TSAsExpression(nestedDoubleAssertionNode());

  const outerCastStart = nestedSource.lastIndexOf("as unknown");
  assertEquals(reports.length, 1);
  assertEquals(reports[0]!.range, [
    outerCastStart,
    outerCastStart + doubleCastText.length,
  ]);
});

Deno.test("baselineKeyForNode returns the relative file location", () => {
  const key = baselineKeyForNode(createContext([]), doubleAssertionNode());

  assertEquals(key?.file, "fixture.ts");
  assertEquals(key?.line, 1);
  assertEquals(key?.column, 18);
  assertEquals(typeof key?.fingerprint, "string");
});

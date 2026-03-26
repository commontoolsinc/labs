import ts from "typescript";
import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";

import {
  classifyArrayMethodResultSinkCall,
  detectCallKind,
  isReactiveOriginCall,
} from "../../src/ast/mod.ts";
import { analyzeExpression } from "./harness.ts";

function getCallExpression(
  source: string,
  options?: Parameters<typeof analyzeExpression>[1],
) {
  const { expression, checker } = analyzeExpression(source, options);
  assert(ts.isCallExpression(expression), "Expected a call expression");
  return { call: expression, checker };
}

describe("data flow analyzer", () => {
  it("marks ifElse predicate for selective rewriting", () => {
    const { analysis } = analyzeExpression(
      "ifElse(state.count > 3, 'hi', 'bye')",
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else",
    );
    assertEquals(
      analysis.rewriteHint.predicate.getText(),
      "state.count > 3",
    );
  });

  it("identifies array map calls that should skip wrapping", () => {
    const { analysis } = analyzeExpression(
      "state.items.map(item => item + state.count)",
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "skip-call-rewrite",
    );
    assertEquals(analysis.rewriteHint.reason, "array-method");
  });

  it("does not treat custom map methods as array-method rewrite hints", () => {
    const { analysis } = analyzeExpression(
      "collection.map((item) => item + state.count)",
      {
        prelude: `
declare const collection: {
  map<T>(fn: (item: number) => T): T[];
};
        `,
      },
    );

    assertEquals(analysis.rewriteHint, undefined);
  });

  it("recognises ifElse when called via alias", () => {
    const { analysis } = analyzeExpression(
      "aliasIfElse(state.count > 3, 'hi', 'bye')",
      { prelude: "declare const aliasIfElse: typeof ifElse;" },
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else",
    );
  });

  it("recognises builders when called via alias", () => {
    const { analysis } = analyzeExpression(
      "aliasPattern(() => state.count)",
      { prelude: "declare const aliasPattern: typeof pattern;" },
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "skip-call-rewrite",
    );
    assertEquals(analysis.rewriteHint.reason, "builder");
  });

  it("does not classify a shadowed local derive helper as reactive", () => {
    const { call, checker } = getCallExpression(
      "derive(() => 1)",
      {
        prelude: "function derive<T>(fn: () => T): T { return fn(); }",
      },
    );

    assertEquals(detectCallKind(call, checker), undefined);
    assertEquals(isReactiveOriginCall(call, checker), false);
  });

  it("does not classify a shadowed property helper named ifElse", () => {
    const { call, checker } = getCallExpression(
      "helpers.ifElse(state.count > 3, 'hi', 'bye')",
      {
        prelude: `
declare const helpers: {
  ifElse<T>(predicate: boolean, whenTrue: T, whenFalse: T): T;
};
        `,
      },
    );

    assertEquals(detectCallKind(call, checker), undefined);
  });

  it("does not classify plain object map methods as reactive array calls", () => {
    const { call, checker } = getCallExpression(
      "collection.map((item) => item + 1)",
      {
        prelude: `
declare const collection: {
  map<T>(fn: (item: number) => T): T[];
};
        `,
      },
    );

    assertEquals(detectCallKind(call, checker), undefined);
  });

  it("does not classify custom map(...).join(...) chains as array sinks", () => {
    const { call, checker } = getCallExpression(
      'collection.map((item) => item + 1).join(",")',
      {
        prelude: `
declare const collection: {
  map<T>(fn: (item: number) => T): {
    join(separator: string): string;
  };
};
        `,
      },
    );

    assertEquals(classifyArrayMethodResultSinkCall(call, checker), undefined);
  });

  it("recognises fetchData as a reactive origin call", () => {
    const { call, checker } = getCallExpression(
      'fetchData({ url: "https://example.com", result: [] })',
      {
        prelude:
          "declare function fetchData<T>(args: { url: string; result: T }): T;",
      },
    );

    assertEquals(detectCallKind(call, checker)?.kind, "runtime-call");
    assertEquals(isReactiveOriginCall(call, checker), true);
  });
});

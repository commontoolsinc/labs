import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";

import { analyzeExpression } from "./harness.ts";

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
    assertEquals(analysis.rewriteHint.reason, "array-map");
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
      "aliasRecipe(() => state.count)",
      { prelude: "declare const aliasRecipe: typeof recipe;" },
    );

    assert(
      analysis.rewriteHint && analysis.rewriteHint.kind === "skip-call-rewrite",
    );
    assertEquals(analysis.rewriteHint.reason, "builder");
  });
});

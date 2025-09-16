import { describe, it } from "@std/testing/bdd";
import { assertEquals, assert } from "@std/assert";

import { analyseExpression } from "./harness.ts";

describe("dependency analyzer", () => {
  it("marks ifElse predicate for selective rewriting", () => {
    const { analysis } = analyseExpression(
      "ifElse(state.count > 3, 'hi', 'bye')",
    );

    assert(analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else");
    assertEquals(
      analysis.rewriteHint.predicate.getText(),
      "state.count > 3",
    );
  });

  it("identifies array map calls that should skip wrapping", () => {
    const { analysis } = analyseExpression(
      "state.items.map(item => item + state.count)",
    );

    assert(analysis.rewriteHint && analysis.rewriteHint.kind === "skip-call-rewrite");
    assertEquals(analysis.rewriteHint.reason, "array-map");
  });
});

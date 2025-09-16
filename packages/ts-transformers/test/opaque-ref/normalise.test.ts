import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";

import {
  normaliseDependencies,
  selectDependenciesWithin,
} from "../../src/opaque-ref/normalise.ts";
import { analyseExpression } from "./harness.ts";

describe("normaliseDependencies", () => {
  it("filters dependencies within a specific node", () => {
    const { analysis } = analyseExpression(
      "ifElse(state.count > 3, 'hi', 'bye')",
    );

    const dependencies = normaliseDependencies(analysis.graph);
    const predicate = analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else"
      ? analysis.rewriteHint.predicate
      : undefined;
    if (!predicate) {
      throw new Error("Expected predicate hint");
    }

    const filtered = selectDependenciesWithin(dependencies, predicate);
    assertEquals(filtered.length, 1);
    assertEquals(filtered[0].expression.getText(), "state.count");
  });
});

import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { assertDefined } from "../../src/core/assert.ts";

import {
  normaliseDataFlows,
  selectDataFlowsWithin,
} from "../../src/opaque-ref/normalise.ts";
import { analyseExpression } from "./harness.ts";

describe("normaliseDataFlows", () => {
  it("filters data flows within a specific node", () => {
    const { analysis } = analyseExpression(
      "ifElse(state.count > 3, 'hi', 'bye')",
    );

    const dataFlows = normaliseDataFlows(analysis.graph);
    const predicate =
      analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else"
        ? analysis.rewriteHint.predicate
        : undefined;
    if (!predicate) {
      throw new Error("Expected predicate hint");
    }

    const filtered = selectDataFlowsWithin(dataFlows, predicate);
    assertEquals(filtered.length, 1);
    const firstDependency = assertDefined(
      filtered[0],
      "Expected dataFlow inside predicate",
    );
    assertEquals(firstDependency.expression.getText(), "state.count");
  });
});

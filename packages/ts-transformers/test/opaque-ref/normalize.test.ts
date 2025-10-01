import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";

import {
  normalizeDataFlows,
  selectDataFlowsWithin,
} from "../../src/ast/mod.ts";
import { analyzeExpression } from "./harness.ts";

describe("normalizeDataFlows", () => {
  it("filters data flows within a specific node", () => {
    const { analysis } = analyzeExpression(
      "ifElse(state.count > 3, 'hi', 'bye')",
    );

    const dataFlows = normalizeDataFlows(analysis.graph);
    const predicate =
      analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else"
        ? analysis.rewriteHint.predicate
        : undefined;
    if (!predicate) {
      throw new Error("Expected predicate hint");
    }

    const filtered = selectDataFlowsWithin(dataFlows, predicate);
    assertEquals(filtered.length, 1);
    const firstDependency = filtered[0];
    assert(
      firstDependency,
      "Expected dataFlow inside predicate",
    );
    assertEquals(firstDependency.expression.getText(), "state.count");
  });
});

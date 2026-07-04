import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ImmutableJSONValue } from "@commonfabric/api";
import { llmDialogTestHelpers } from "../src/builtins/llm-dialog.ts";

const { toolAllowsObservedConfidentiality } = llmDialogTestHelpers;

// Regression guard for empty tool-ceiling semantics (review follow-up to W0.7).
//
// W0.7 made an empty maxConfidentiality "public only" in cfcObservationFitsCeiling,
// but the LLM tool-call gate kept special-casing an empty ceiling as allow-all,
// so a tool declaring ifc.maxConfidentiality: [] still received confidential
// observations. A declared (even empty) ceiling must be enforced.
describe("CFC tool ceiling empty", () => {
  const catalogWithToolCeiling = (
    maxConfidentiality: readonly ImmutableJSONValue[] | undefined,
  ): Parameters<typeof toolAllowsObservedConfidentiality>[0] => ({
    llmTools: {
      mytool: {
        description: "test tool",
        inputSchema: { type: "object", ifc: { maxConfidentiality } },
      },
    },
    dynamicToolCells: new Map(),
  });

  it("denies confidential observations under an empty tool ceiling", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling([]),
        "mytool",
        ["secret"],
      ),
    ).toBe(false);
  });

  it("allows public observations under an empty tool ceiling", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling([]),
        "mytool",
        [],
      ),
    ).toBe(true);
  });

  it("allows when no ceiling is declared (non-array)", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling(undefined),
        "mytool",
        ["secret"],
      ),
    ).toBe(true);
  });

  it("enforces a populated tool ceiling", () => {
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling(["a"]),
        "mytool",
        ["a"],
      ),
    ).toBe(true);
    expect(
      toolAllowsObservedConfidentiality(
        catalogWithToolCeiling(["a"]),
        "mytool",
        ["b"],
      ),
    ).toBe(false);
  });
});

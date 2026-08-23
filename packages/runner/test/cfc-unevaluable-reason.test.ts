/**
 * The verdict / evaluation-failure split a CFC prepare rejection turns on.
 *
 * A refusal is terminal — never retried, surfaced — only when it is a VERDICT
 * on the transaction's data. When prepare could not evaluate because an input
 * was unavailable, the identical re-run can decide differently once that input
 * loads, so the rejection must stay retryable. Collapsing the two strands the
 * write: the served-wish state never lands and its UI silently never mounts.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CFC_UNEVALUABLE_REASON,
  hasUnevaluableReason,
  isUnevaluableReason,
  unevaluableReason,
} from "../src/cfc/unevaluable-reason.ts";

describe("cfc-unevaluable-reason", () => {
  it("keeps the human-readable text after the token", () => {
    // Existing assertions match the prose as a substring; tagging must not
    // rewrite it.
    const tagged = unevaluableReason("missing link source metadata for of:x");
    expect(tagged).toContain("missing link source metadata for of:x");
    expect(tagged.startsWith(`${CFC_UNEVALUABLE_REASON}: `)).toBe(true);
  });

  it("recognizes a tagged reason and rejects an untagged one", () => {
    expect(isUnevaluableReason(unevaluableReason("schema load failed")))
      .toBe(true);
    expect(isUnevaluableReason("writer-fit confidentiality misfit at /body"))
      .toBe(false);
  });

  it("does not match the token appearing incidentally inside prose", () => {
    // The token is matched at the START of a reason, the only position the
    // tagger produces, so a value or path that merely contains the word
    // cannot promote a verdict into a retryable refusal.
    expect(isUnevaluableReason(`refused write at /${CFC_UNEVALUABLE_REASON}`))
      .toBe(false);
  });

  it("reports a mixed refusal as unevaluable", () => {
    // Any, not every: once the unavailable input loads, the re-run may
    // produce only the verdict — which refuses again on its own terms.
    expect(hasUnevaluableReason([
      "writer-fit confidentiality misfit at /body",
      unevaluableReason("missing schema write-policy input for of:y"),
    ])).toBe(true);
  });

  it("reports an all-verdict refusal as evaluable", () => {
    expect(hasUnevaluableReason([
      "writer-fit confidentiality misfit at /body",
      "unprivileged write to protected cfc path of:z/cfc/labelMap",
    ])).toBe(false);
    expect(hasUnevaluableReason([])).toBe(false);
  });
});

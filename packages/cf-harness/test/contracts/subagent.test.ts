import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  asHarnessSubagentFailureReport,
  PATTERN_AUTHOR_RETURN_SCHEMA,
  SUBAGENT_FAILURE_REASON_CODES,
} from "../../src/contracts/subagent.ts";
import { validateAndSanitizeSubagentReturn } from "../../src/subagent-return.ts";

/**
 * The schema and the value a real `pattern-author` delegation produced, where
 * the child's correct failure report came back to the parent as a schema
 * mismatch. The union's branches carry every property; the node above them
 * carries `type: "object"` and none.
 */
const DELEGATION_UNION_SCHEMA = {
  type: "object",
  oneOf: [
    {
      properties: {
        ok: { const: true },
        resultRef: { type: "string" },
        describes: { type: "object", additionalProperties: false },
      },
      required: ["ok", "resultRef", "describes"],
      additionalProperties: false,
    },
    {
      properties: {
        ok: { const: false },
        reason: { type: "string" },
      },
      required: ["ok", "reason"],
      additionalProperties: false,
    },
  ],
} as const;

const REPORTED_FAILURE = {
  ok: false,
  reason:
    "The pattern ran, but the harness returned only opaque values for the derived totals, so I cannot populate the required describes.totals JSON without reading or exposing protected space data.",
};

describe("subagent", () => {
  describe("return contract", () => {
    it("accepts a failure branch declared under a typed `oneOf` union", () => {
      const sanitized = validateAndSanitizeSubagentReturn({
        schema: DELEGATION_UNION_SCHEMA,
        childRunId: "run-union.subagent.1",
        value: REPORTED_FAILURE,
      });

      expect(sanitized.value).toEqual({
        ok: false,
        reason: { "@link": "opaque:run-union.subagent.1#/reason" },
      });
      expect(sanitized.linkedStringCount).toBe(1);
    });

    it("keeps the failure code inert and seals the detail beside it", () => {
      const sanitized = validateAndSanitizeSubagentReturn({
        schema: PATTERN_AUTHOR_RETURN_SCHEMA,
        childRunId: "run-codes.subagent.1",
        value: {
          ok: false,
          code: "compile-error",
          detail: "the third rewrite still would not compile",
        },
      });

      expect(sanitized.value).toEqual({
        ok: false,
        code: "compile-error",
        detail: { "@link": "opaque:run-codes.subagent.1#/detail" },
      });
      expect(sanitized.linkedStringCount).toBe(1);
    });

    it("keeps the success branch's `resultRef` and seals its prose", () => {
      const sanitized = validateAndSanitizeSubagentReturn({
        schema: PATTERN_AUTHOR_RETURN_SCHEMA,
        childRunId: "run-codes.subagent.2",
        value: {
          ok: true,
          resultRef: "cfh:a:9mfcd",
          describes: "Totals each category against its budget.",
        },
      });

      expect(sanitized.value).toEqual({
        ok: true,
        resultRef: { "@link": "opaque:run-codes.subagent.2#/resultRef" },
        describes: { "@link": "opaque:run-codes.subagent.2#/describes" },
      });
    });

    it("throws for a failure code outside the vocabulary", () => {
      expect(() =>
        validateAndSanitizeSubagentReturn({
          schema: PATTERN_AUTHOR_RETURN_SCHEMA,
          childRunId: "run-codes.subagent.3",
          value: { ok: false, code: "the space refused my read of row 4" },
        })
      ).toThrow();
    });

    it("admits every declared reason code", () => {
      for (const code of SUBAGENT_FAILURE_REASON_CODES) {
        const sanitized = validateAndSanitizeSubagentReturn({
          schema: PATTERN_AUTHOR_RETURN_SCHEMA,
          childRunId: "run-codes.subagent.4",
          value: { ok: false, code },
        });
        expect(sanitized.value).toEqual({ ok: false, code });
      }
    });
  });

  describe("asHarnessSubagentFailureReport", () => {
    it("returns the declared code for a coded failure return", () => {
      expect(
        asHarnessSubagentFailureReport({
          ok: false,
          code: "turn-budget-exhausted",
        }),
      ).toEqual({ code: "turn-budget-exhausted" });
    });

    it("returns `other` for an ok:false return with no recognized code", () => {
      expect(asHarnessSubagentFailureReport(REPORTED_FAILURE)).toEqual({
        code: "other",
      });
      expect(asHarnessSubagentFailureReport({ ok: false, code: "invented" }))
        .toEqual({ code: "other" });
    });

    it("returns undefined for anything that does not say ok:false", () => {
      expect(asHarnessSubagentFailureReport({ ok: true })).toBeUndefined();
      expect(asHarnessSubagentFailureReport({ ok: "false" })).toBeUndefined();
      expect(asHarnessSubagentFailureReport("failed")).toBeUndefined();
      expect(asHarnessSubagentFailureReport(null)).toBeUndefined();
      expect(asHarnessSubagentFailureReport([{ ok: false }])).toBeUndefined();
    });
  });
});

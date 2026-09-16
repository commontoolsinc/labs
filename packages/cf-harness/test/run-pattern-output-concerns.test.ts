/**
 * What `run_pattern` reads off a materialized pattern's own outputs, and what
 * it says about them. The end-to-end statement — that a composed reader's
 * failure reaches the run's answer while the run still succeeds — is in
 * run-pattern-pattern-index.test.ts, where a composition has an index to
 * resolve through.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  dedupedOutputConcerns,
  OUTPUT_CONCERN_MESSAGES,
  outputConcernsIn,
} from "../src/run-pattern-output-concerns.ts";

/** The outputs a connector-reading atom exposes beside its rows. */
const readerResult = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  month: "2026-09",
  rows: [{ id: 1 }],
  rowCount: 1,
  pending: false,
  errorMessage: "",
  ...overrides,
});

describe("run-pattern-output-concerns", () => {
  describe("outputConcernsIn()", () => {
    it("returns nothing for a result whose reads all landed", () => {
      expect(outputConcernsIn(readerResult())).toEqual([]);
    });

    it("names the output an error message was read from", () => {
      expect(
        outputConcernsIn(readerResult({ errorMessage: "no such column: x" })),
      ).toEqual([{
        concern: "error-branch",
        key: "errorMessage",
        message: OUTPUT_CONCERN_MESSAGES["error-branch"],
      }]);
    });

    it("names the pattern an output was read from when one is given", () => {
      expect(
        outputConcernsIn(
          readerResult({ errorMessage: "no such column: x" }),
          "patternIdentity",
        )[0].patternId,
      ).toBe("patternIdentity");
    });

    it("carries none of the error's own text", () => {
      const concerns = outputConcernsIn(
        readerResult({ errorMessage: "no such column: secretColumnName" }),
      );

      expect(JSON.stringify(concerns)).not.toContain("secretColumnName");
    });

    it("reads a runtime SQLite failure under an output named anything", () => {
      expect(
        outputConcernsIn({
          status: "sqlite: param is undefined (it may be a value that isn't " +
            "ready yet); pass a resolved value, or null for SQL NULL",
        }).map((concern) => concern.key),
      ).toEqual(["status"]);
    });

    it("leaves a string that merely mentions sqlite alone", () => {
      expect(outputConcernsIn({ caption: "rows from the sqlite store" }))
        .toEqual([]);
    });

    it("names an output holding no rows", () => {
      expect(
        outputConcernsIn(readerResult({ rows: [], rowCount: 0 })),
      ).toEqual([{
        concern: "no-rows",
        key: "rows",
        message: OUTPUT_CONCERN_MESSAGES["no-rows"],
      }]);
    });

    it("names both an output that failed and an output left empty", () => {
      expect(
        outputConcernsIn(readerResult({
          rows: [],
          rowCount: 0,
          errorMessage: "sqlite: param is undefined",
        })).map((concern) => `${concern.key}:${concern.concern}`),
      ).toEqual(["rows:no-rows", "errorMessage:error-branch"]);
    });

    it("leaves the framework's own result keys alone", () => {
      expect(outputConcernsIn({ $UI: [], $NAME: "" })).toEqual([]);
    });

    it("reads only the top level of a result", () => {
      expect(outputConcernsIn({ inner: { rows: [], errorMessage: "broke" } }))
        .toEqual([]);
    });

    it("returns nothing for a result that is not an object", () => {
      expect(outputConcernsIn(["rows"])).toEqual([]);
      expect(outputConcernsIn(undefined)).toEqual([]);
    });
  });

  describe("dedupedOutputConcerns()", () => {
    it("states an output one pattern reported many times once", () => {
      const repeated = outputConcernsIn({ rows: [] }, "reader");

      expect(dedupedOutputConcerns([...repeated, ...repeated, ...repeated]))
        .toEqual(repeated);
    });

    it("keeps the same output read from two different patterns", () => {
      expect(
        dedupedOutputConcerns([
          ...outputConcernsIn({ rows: [] }, "ledger"),
          ...outputConcernsIn({ rows: [] }, "mailbox"),
        ]).map((concern) => concern.patternId),
      ).toEqual(["ledger", "mailbox"]);
    });

    it("keeps two outputs of one pattern apart", () => {
      expect(
        dedupedOutputConcerns(
          outputConcernsIn({ rows: [], errorMessage: "broke" }, "reader"),
        ).map((concern) => `${concern.key}:${concern.concern}`),
      ).toEqual(["rows:no-rows", "errorMessage:error-branch"]);
    });
  });
});

/**
 * What `run_pattern` reads off a materialized pattern's own outputs, what it
 * tells the model, and what it keeps for the artifact alone. The end-to-end
 * statement — that a composed reader's failure reaches the run's answer while
 * the run still succeeds — is in run-pattern-pattern-index.test.ts, where a
 * composition has an index to resolve through.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  dedupedObservedOutputs,
  type ObservedOutput,
  observedOutputCause,
  observedOutputsIn,
  OUTPUT_CONCERN_MESSAGES,
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

/** What each observation says, as `<key>:<kind>`. */
const positions = (observed: readonly ObservedOutput[]): string[] =>
  observed.map((one) => `${one.concern.key}:${one.concern.concern}`);

describe("run-pattern-output-concerns", () => {
  describe("observedOutputsIn()", () => {
    it("returns nothing for a result whose reads all landed", () => {
      expect(observedOutputsIn(readerResult())).toEqual([]);
    });

    it("names the output an error message was read from", () => {
      expect(
        observedOutputsIn(readerResult({ errorMessage: "no such column: x" }))
          .map((one) => one.concern),
      ).toEqual([{
        concern: "error-branch",
        key: "errorMessage",
        message: OUTPUT_CONCERN_MESSAGES["error-branch"],
      }]);
    });

    it("names the pattern an output was read from when one is given", () => {
      expect(
        observedOutputsIn(
          readerResult({ errorMessage: "no such column: x" }),
          "patternIdentity",
        )[0].concern.patternId,
      ).toBe("patternIdentity");
    });

    it("keeps the error's own text out of what the model is told", () => {
      const observed = observedOutputsIn(
        readerResult({ errorMessage: "no such column: secretColumnName" }),
      );

      expect(JSON.stringify(observed.map((one) => one.concern)))
        .not.toContain("secretColumnName");
      expect(observed[0].text).toBe("no such column: secretColumnName");
    });

    it("reads a runtime SQLite failure under an output named anything", () => {
      expect(
        positions(observedOutputsIn({
          status: "sqlite: param is undefined (it may be a value that isn't " +
            "ready yet); pass a resolved value, or null for SQL NULL",
        })),
      ).toEqual(["status:error-branch"]);
    });

    it("leaves a string that merely mentions sqlite alone", () => {
      expect(observedOutputsIn({ caption: "rows from the sqlite store" }))
        .toEqual([]);
    });

    it("names an output holding no rows, with no text to keep", () => {
      const observed = observedOutputsIn(
        readerResult({ rows: [], rowCount: 0 }),
      );

      expect(observed.map((one) => one.concern)).toEqual([{
        concern: "no-rows",
        key: "rows",
        message: OUTPUT_CONCERN_MESSAGES["no-rows"],
      }]);
      expect(observed[0].text).toBe("");
    });

    it("names both an output that failed and an output left empty", () => {
      expect(
        positions(observedOutputsIn(readerResult({
          rows: [],
          rowCount: 0,
          errorMessage: "sqlite: param is undefined",
        }))),
      ).toEqual(["rows:no-rows", "errorMessage:error-branch"]);
    });

    it("passes over an empty output of a read still in flight", () => {
      expect(
        positions(observedOutputsIn(
          readerResult({ rows: [], rowCount: 0, pending: true }),
        )),
      ).toEqual([]);
    });

    it("names the failure of a read still in flight", () => {
      expect(
        positions(observedOutputsIn(readerResult({
          rows: [],
          pending: true,
          errorMessage: "no such column: x",
        }))),
      ).toEqual(["errorMessage:error-branch"]);
    });

    it("leaves the framework's own result keys alone", () => {
      expect(observedOutputsIn({ $UI: [], $NAME: "" })).toEqual([]);
    });

    it("reads only the top level of a result", () => {
      expect(observedOutputsIn({ inner: { rows: [], errorMessage: "broke" } }))
        .toEqual([]);
    });

    it("returns nothing for a result that is not an object", () => {
      expect(observedOutputsIn(["rows"])).toEqual([]);
      expect(observedOutputsIn(undefined)).toEqual([]);
    });
  });

  describe("dedupedObservedOutputs()", () => {
    it("states an output one pattern reported many times once", () => {
      const repeated = observedOutputsIn({ rows: [] }, "reader");

      expect(dedupedObservedOutputs([...repeated, ...repeated, ...repeated]))
        .toEqual(repeated);
    });

    it("keeps the same output read from two different patterns", () => {
      expect(
        dedupedObservedOutputs([
          ...observedOutputsIn({ rows: [] }, "ledger"),
          ...observedOutputsIn({ rows: [] }, "mailbox"),
        ]).map((one) => one.concern.patternId),
      ).toEqual(["ledger", "mailbox"]);
    });

    it("keeps two outputs of one pattern apart", () => {
      expect(
        positions(dedupedObservedOutputs(
          observedOutputsIn({ rows: [], errorMessage: "broke" }, "reader"),
        )),
      ).toEqual(["rows:no-rows", "errorMessage:error-branch"]);
    });
  });

  describe("observedOutputCause()", () => {
    it("returns nothing when nothing was observed", () => {
      expect(observedOutputCause([])).toBeUndefined();
    });

    it("names each position and the text the model was not told", () => {
      expect(
        observedOutputCause(
          observedOutputsIn({ errorMessage: "no such column: x" }, "reader"),
        ),
      ).toBe("reader errorMessage (error-branch): no such column: x");
    });

    it("names the run's own result for an output no pattern id came with", () => {
      expect(observedOutputCause(observedOutputsIn({ rows: [] })))
        .toBe("this run's own result rows (no-rows)");
    });

    it("writes one line per observation", () => {
      expect(
        observedOutputCause(
          observedOutputsIn({ rows: [], errorMessage: "broke" }, "reader"),
        )?.split("\n"),
      ).toEqual([
        "reader rows (no-rows)",
        "reader errorMessage (error-branch): broke",
      ]);
    });
  });
});

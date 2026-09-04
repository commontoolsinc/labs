import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { XDebuggerView } from "../src/views/DebuggerView.ts";

/** Flattens a Lit template result, its values included, to its markup. */
function templateMarkup(value: unknown): string {
  if (Array.isArray(value)) return value.map(templateMarkup).join("");
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  const template = value as {
    strings?: readonly string[];
    values?: readonly unknown[];
  };
  if (template.strings === undefined) return "";
  return template.strings.map((part, index) =>
    part + templateMarkup(template.values?.[index])
  ).join("");
}

describe("XDebuggerView", () => {
  describe("instance members", () => {
    describe("renderDiagnosis()", () => {
      it("renders a non-idempotent report's runs, a `bigint` write included", () => {
        // A run's reads and writes are `FabricValue`s, which a `bigint` is.
        // The method reads the controller's result and the duration off
        // `this`, so a stand-in carrying those two is enough to render it.

        const result = {
          duration: 5000,
          busyTime: 100,
          cycles: [],
          nonIdempotent: [{
            actionId: "action-1",
            runs: [{
              timestamp: 1,
              reads: { in: 1 },
              writes: { out: 12345678901234567890n },
            }],
            differingWriteKeys: ["out"],
          }],
        };
        const view = {
          debuggerController: {
            getIsDiagnosing: () => false,
            getDiagnosisResult: () => result,
          },
          diagnosisDurationMs: 5000,
        };
        const render = (XDebuggerView.prototype as unknown as {
          renderDiagnosis(this: unknown): unknown;
        }).renderDiagnosis;

        const markup = templateMarkup(render.call(view));
        expect(markup).toContain("out: 12345678901234567890n");
      });
    });
  });
});

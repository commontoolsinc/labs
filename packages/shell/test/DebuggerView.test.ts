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
      it("renders every run of a non-idempotent report and every cell it wrote, a `bigint` included", () => {
        // A run's reads and writes are `FabricValue`s, which a `bigint` is.
        // The method reads the controller's result and the duration off
        // `this`, so a stand-in carrying those two is enough to render it.
        // The run count and the write count both exceed the debugger's usual
        // array and property limits, so the panel showing the last of each
        // is what the assertions pin.

        const writes = Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`out${i}`, BigInt(i)]),
        );
        const runs = Array.from({ length: 8 }, (_, i) => ({
          timestamp: i,
          reads: { in: 1 },
          writes,
        }));
        const result = {
          duration: 5000,
          busyTime: 100,
          cycles: [],
          nonIdempotent: [{
            actionId: "action-1",
            runs,
            differingWriteKeys: ["out0"],
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
        expect(markup).toContain("timestamp: 7");
        expect(markup).toContain("out24: 24n");
        expect(markup).not.toContain("/...");
      });
    });
  });
});

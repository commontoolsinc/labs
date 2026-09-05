import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { DebuggerController } from "../src/lib/debugger-controller.ts";
import { XDebuggerView } from "../src/views/DebuggerView.ts";
import { templateMarkup } from "./lit-template-markup.ts";

describe("XDebuggerView", () => {
  describe("instance members", () => {
    describe("renderDiagnosis()", () => {
      it("renders every run of a non-idempotent report and every cell it wrote, a `bigint` included", () => {
        // A run's reads and writes are `FabricValue`s, which a `bigint` is.
        // The method reads the controller's result and the duration off
        // `this`; the controller stand-in offers the two reads it makes, and
        // the duration is the view's default.
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
        const view = new XDebuggerView();
        view.debuggerController = {
          getIsDiagnosing: () => false,
          getDiagnosisResult: () => result,
        } as unknown as DebuggerController;

        const markup = templateMarkup(
          view.accessForTestingOnly.renderDiagnosis(),
        );
        expect(markup).toContain("timestamp: 7");
        expect(markup).toContain("out24: 24n");
        expect(markup).not.toContain("... length:");
        expect(markup).not.toContain("... count:");
      });
    });
  });
});

/**
 * The accumulator itself: what it does with each state it can be moved into,
 * and what it refuses to be moved into.
 *
 * Two directions matter. Confidentiality only accumulates, so a later clean
 * invocation cannot lower what an earlier one established. And a run that
 * lost track of an invocation stays lost, because nothing later can establish
 * what that invocation did.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  forgetSandboxTaintForTesting,
  joinSandboxTaint,
  poisonSandboxTaint,
  sandboxTaint,
  seedSandboxTaint,
} from "../src/sandbox-taint.ts";

const withRun = (body: (runId: string) => void): void => {
  const runId = `taint-${crypto.randomUUID()}`;
  try {
    body(runId);
  } finally {
    forgetSandboxTaintForTesting(runId);
  }
};

describe("a run's accumulated sandbox taint", () => {
  it("starts knowing that nothing has been accumulated", () => {
    withRun((runId) => {
      expect(sandboxTaint(runId)).toEqual({ kind: "known" });
    });
  });

  it("accumulates confidentiality across invocations", () => {
    withRun((runId) => {
      joinSandboxTaint(runId, { confidentiality: ["finance"] });
      joinSandboxTaint(runId, { confidentiality: ["health"] });

      expect(sandboxTaint(runId)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance", "health"] },
      });
    });
  });

  it("keeps what it has when a later invocation reports nothing", () => {
    withRun((runId) => {
      joinSandboxTaint(runId, { confidentiality: ["finance"] });
      joinSandboxTaint(runId, {});

      expect(sandboxTaint(runId)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("drops integrity, which the checked write path cannot add", () => {
    withRun((runId) => {
      joinSandboxTaint(runId, {
        confidentiality: ["finance"],
        integrity: ["trusted"],
      });

      expect(sandboxTaint(runId)).toEqual({
        kind: "known",
        label: { confidentiality: ["finance"] },
      });
    });
  });

  it("stays lost once an invocation left no evidence", () => {
    withRun((runId) => {
      poisonSandboxTaint(runId, "first reason");
      poisonSandboxTaint(runId, "second reason");
      joinSandboxTaint(runId, { confidentiality: ["finance"] });

      // The first reason names the invocation that lost the evidence; a later
      // one describes a run that was already lost.
      expect(sandboxTaint(runId)).toEqual({
        kind: "unknown",
        reason: "first reason",
      });
    });
  });

  it("poisons rather than accumulating a label it cannot read", () => {
    withRun((runId) => {
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);

      const taint = joinSandboxTaint(
        runId,
        { confidentiality: cyclic } as unknown as { confidentiality: string[] },
      );

      expect(taint.kind).toBe("unknown");
    });
  });

  it("seeds a resumed run from what its record says", () => {
    withRun((runId) => {
      expect(
        seedSandboxTaint(runId, {
          kind: "known",
          label: { confidentiality: ["finance"] },
        }),
      ).toEqual({ kind: "known", label: { confidentiality: ["finance"] } });
    });

    withRun((runId) => {
      expect(seedSandboxTaint(runId, { kind: "unknown", reason: "lost" }))
        .toEqual({ kind: "unknown", reason: "lost" });
    });

    withRun((runId) => {
      // A record that states a clean run says so; nothing is accumulated.
      expect(seedSandboxTaint(runId, { kind: "known" })).toEqual({
        kind: "known",
      });
    });
  });

  it("treats a record that says nothing as a run it cannot account for", () => {
    // Absence is not evidence of a clean run: this process saw none of the
    // earlier invocations, and the record it resumed from does not say.
    withRun((runId) => {
      expect(seedSandboxTaint(runId, undefined).kind).toBe("unknown");
    });
  });

  it("treats a record it cannot read as a run it cannot account for", () => {
    for (
      const stored of [
        { kind: "clean" },
        { kind: "unknown" },
        { kind: "known", label: { confidentiality: "finance" } },
        "known",
        42,
        null,
      ]
    ) {
      withRun((runId) => {
        expect(
          seedSandboxTaint(runId, stored as never).kind,
        ).toBe("unknown");
      });
    }
  });
});

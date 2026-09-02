/**
 * What each check is for: the shape it is supposed to catch, seeded into a
 * clean run and required to turn that check's verdict and no other's.
 *
 * The two halves matter equally. A check whose verdict never turns cannot
 * fail, and a check that reports a finding on every neighboring mutation says
 * nothing about the clause it cites. Each case here therefore asserts the
 * whole verdict map, so a check that widens to catch its neighbor's violation
 * fails here rather than in a reviewer's reading.
 *
 * The mutations are in memory. Nothing writes into the fixture tree, which is
 * the same discipline the checker itself holds to.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import type { HarnessHandleEntry } from "../../src/contracts/handle-table.ts";
import type {
  HarnessPolicyDecisionReasonCode,
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "../../src/contracts/policy-trace.ts";
import type { HarnessRunReport } from "../../src/contracts/run-report.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import { auditRunFamily, STRUCTURAL_CHECKS } from "../checks/structural.ts";
import {
  loadRunFamily,
  type RunEvidence,
  type RunFamily,
} from "../evidence.ts";
import type { CheckVerdict } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

/** Every check's verdict, keyed by check and run. */
const verdicts = (audited: RunFamily): Record<string, CheckVerdict> =>
  Object.fromEntries(
    auditRunFamily(audited).map((
      result,
    ) => [`${result.checkId}@${result.runId}`, result.verdict]),
  );

const CLEAN = verdicts(family);

/** The parent run's key for a check, which is where every mutation lands. */
const at = (checkId: string): string => `${checkId}@${FIXTURE_RUN_ID}`;

/** The family with `mutate` applied to a deep copy of its root run. */
const seeded = (mutate: (root: RunEvidence) => void): RunFamily => {
  const root = structuredClone(family.root);
  mutate(root);
  return { root, children: structuredClone(family.children) };
};

/**
 * Asserts that seeding `mutate` turns exactly `checkId`'s verdict, to
 * `expected`, and leaves every other verdict of the family where it was.
 */
const turnsOnly = (
  checkId: string,
  expected: CheckVerdict,
  mutate: (root: RunEvidence) => void,
): void => {
  expect(verdicts(seeded(mutate))).toEqual({
    ...CLEAN,
    [at(checkId)]: expected,
  });
};

/**
 * A persisted artifact as a seeding step may edit it.
 *
 * The contracts declare their lists `readonly`, which is right for the code
 * that produces them and wrong here: what a violation is, is an artifact
 * tree that says something the contract's producer would not have written.
 */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer E)[]
    ? (E extends object ? Mutable<E> : E)[]
    : T[K];
};

const stateOf = (run: RunEvidence): Mutable<HarnessRunState> => {
  if (run.runState.status !== "present") {
    throw new Error("the fixture's run state did not load");
  }
  return run.runState.value as Mutable<HarnessRunState>;
};

const traceOf = (run: RunEvidence): Mutable<HarnessPolicyTrace> => {
  if (run.policyTrace.status !== "present") {
    throw new Error("the fixture's policy trace did not load");
  }
  return run.policyTrace.value as Mutable<HarnessPolicyTrace>;
};

const reportOf = (run: RunEvidence): Mutable<HarnessRunReport> => {
  if (run.runReport.status !== "present") {
    throw new Error("the fixture's run report did not load");
  }
  return run.runReport.value as Mutable<HarnessRunReport>;
};

const transcriptOf = (
  run: RunEvidence,
): Mutable<HarnessTranscriptMessage>[] => {
  if (run.transcript.status !== "present") {
    throw new Error("the fixture's transcript did not load");
  }
  return run.transcript.value as Mutable<HarnessTranscriptMessage>[];
};

describe("seeded violations", () => {
  describe("the clean fixture", () => {
    it("finds nothing to report against any check", () => {
      expect(
        Object.entries(CLEAN).filter(([, verdict]) =>
          verdict !== "pass" && verdict !== "not-applicable"
        ),
      ).toEqual([]);
    });

    it("exercises every check on the run that carries the delegation", () => {
      expect(
        STRUCTURAL_CHECKS.filter((check) => CLEAN[at(check.id)] === undefined)
          .map((check) => check.id),
      ).toEqual([]);
    });
  });

  describe("check registration", () => {
    it("names what falsifies every check", () => {
      expect(
        STRUCTURAL_CHECKS.filter((check) => check.falsifiedBy.trim() === "")
          .map((check) => check.id),
      ).toEqual([]);
    });

    it("gives every check a distinct id", () => {
      expect(new Set(STRUCTURAL_CHECKS.map((check) => check.id)).size).toBe(
        STRUCTURAL_CHECKS.length,
      );
    });
  });

  describe("AUD-1 posture consistency", () => {
    it("fails a decision record whose mode differs from the run's", () => {
      turnsOnly("AUD-1", "fail", (root) => {
        traceOf(root).decisions[0]!.cfcEnforcementMode = "enforce-strict";
      });
    });
  });

  describe("AUD-2 mode-behavior attestation", () => {
    it("fails an observe-family reason code under an enforcing claim", () => {
      turnsOnly("AUD-2", "fail", (root) => {
        traceOf(root).decisions[0]!.reasonCodes.push("cfc_observe_read");
      });
    });
  });

  describe("AUD-3 decision coverage", () => {
    it("fails a side-effect activity whose decision was deleted", () => {
      turnsOnly("AUD-3", "fail", (root) => {
        const trace = traceOf(root);
        const report = reportOf(root);
        const dropped = report.toolActivity.find((activity) =>
          activity.effectClass === "side-effect" &&
          activity.policyDecision !== "denied"
        )!;
        const surviving = trace.decisions.filter((decision) =>
          decision.toolCallId !== dropped.toolCallId
        );
        trace.decisions = surviving;
        trace.decisionCounts = {
          total: surviving.length,
          allowed: surviving.filter((one) => one.decision === "allowed").length,
          warned: surviving.filter((one) => one.decision === "warned").length,
          denied: surviving.filter((one) => one.decision === "denied").length,
        };
      });
    });
  });

  describe("AUD-4 denial channel", () => {
    it("fails a denied tool message carrying the withheld payload", () => {
      turnsOnly("AUD-4", "fail", (root) => {
        const denied = reportOf(root).toolActivity.find((activity) =>
          activity.policyDecision === "denied"
        )!;
        for (const message of transcriptOf(root)) {
          if (
            message.role === "tool" && message.toolCallId === denied.toolCallId
          ) {
            message.content = JSON.stringify({
              ...JSON.parse(message.content),
              stdout: "the withheld bytes",
            });
          }
        }
      });
    });
  });

  describe("AUD-5 handle discipline", () => {
    it("fails a handle token the model wrote before any mint disclosed it", () => {
      turnsOnly("AUD-5", "fail", (root) => {
        const token = "cfh:a:zzzzz";
        const entry: HarnessHandleEntry = {
          token,
          kind: "address",
          ref: `/of:fid1:${"B".repeat(43)}`,
          addressKey: "seeded-pre-mint-address",
        };
        stateOf(root).handleTable!.entries.push(entry);
        const assistant = transcriptOf(root).find((message) =>
          message.role === "assistant"
        )!;
        assistant.content = `${assistant.content} ${token}`;
      });
    });
  });

  describe("AUD-6 transcript pairing", () => {
    it("fails a tool result no call is left outstanding for", () => {
      turnsOnly("AUD-6", "fail", (root) => {
        const transcript = transcriptOf(root);
        const last = transcript.findLast((message) => message.role === "tool")!;
        transcript.push(structuredClone(last));
      });
    });
  });

  describe("AUD-7 observe disclosure", () => {
    it("warns rather than passes a run whose every dial stands at observe", () => {
      // Every claim the run owns moves together, reason codes included, so
      // nothing else has a disagreement to report — that shape is AUD-1's
      // finding. What is left is the reading AUD-7 owns: a diagnostic run
      // whose evidence must not be taken for enforcement.

      turnsOnly("AUD-7", "warn", (root) => {
        // Every enforcing reason code has an observe-family counterpart of
        // the same name, so the substitution lands inside the closed union.
        const observing = (
          code: HarnessPolicyDecisionReasonCode,
        ): HarnessPolicyDecisionReasonCode =>
          code.replace(
            /enforce_(explicit|strict)/,
            "observe",
          ) as HarnessPolicyDecisionReasonCode;
        const moveDecisions = (
          decisions: readonly HarnessPolicyDecisionRecord[] | undefined,
        ): void => {
          for (
            const decision of (decisions ??
              []) as Mutable<HarnessPolicyDecisionRecord>[]
          ) {
            decision.cfcEnforcementMode = "observe";
            decision.reasonCodes = decision.reasonCodes.map(observing);
          }
        };
        const state = stateOf(root);
        const report = reportOf(root);
        state.cfcEnforcementMode = "observe";
        report.cfcEnforcementMode = "observe";
        moveDecisions(state.policyDecisions);
        moveDecisions(report.policyDecisions);
        for (const context of state.cfcInvocationContexts ?? []) {
          context.cfcEnforcementMode = "observe";
        }
        for (
          const trace of [traceOf(root), state.policyTrace, report.policyTrace]
        ) {
          if (trace === undefined) continue;
          trace.cfcEnforcementMode = "observe";
          moveDecisions(trace.decisions);
          for (const context of trace.cfcInvocationContexts ?? []) {
            context.cfcEnforcementMode = "observe";
          }
        }
      });
    });
  });

  describe("AUD-8 influence accumulation", () => {
    it("fails a labeled observation stripped from the model context", () => {
      turnsOnly("AUD-8", "fail", (root) => {
        stateOf(root).cfcModelContext!.observations = [];
      });
    });
  });

  describe("AUD-9 evidence retention", () => {
    it("fails an enforcing run whose policy trace is gone", () => {
      turnsOnly("AUD-9", "fail", (root) => {
        root.policyTrace = { status: "absent", path: root.policyTrace.path };
      });
    });
  });
});

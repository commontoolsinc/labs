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

import { inheritedCfcPostureReport } from "@commonfabric/runner/cfc";

import type { HarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type { HarnessHandleEntry } from "../../src/contracts/handle-table.ts";
import type {
  HarnessPolicyDecisionReasonCode,
  HarnessPolicyDecisionRecord,
  HarnessPolicyTrace,
} from "../../src/contracts/policy-trace.ts";
import type { HarnessRunReport } from "../../src/contracts/run-report.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import { RUN_CHECKS } from "../checks/registry.ts";
import { auditRunFamily } from "../checks/structural.ts";
import { harnessFabricSessionPosture } from "../../src/cfc-posture.ts";
import type { HarnessFabricSessionCfcPosture } from "../../src/run-state.ts";
import {
  loadRunFamily,
  type RunEvidence,
  type RunFamily,
  type ToolOutputArtifact,
} from "../evidence.ts";
import type { CheckVerdict } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

/** Every check's verdict, keyed by check and run. */
const verdicts = (audited: RunFamily): Record<string, CheckVerdict> =>
  Object.fromEntries(
    auditRunFamily(audited, RUN_CHECKS).map((
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

/** The tool output the fixture's second invocation context explains. */
const SECOND_BASH_OUTPUT_ID = `${FIXTURE_RUN_ID}:bash:2`;

/**
 * Removes the invocation contexts `drop` selects, from both artifacts that
 * carry them, so the seeded run reads as one that never recorded them rather
 * than as one whose artifacts disagree.
 */
const dropInvocationContexts = (
  run: RunEvidence,
  drop: (context: HarnessCfcInvocationContext) => boolean,
): void => {
  const state = stateOf(run);
  state.cfcInvocationContexts = (state.cfcInvocationContexts ?? []).filter(
    (context) => !drop(context),
  );
  const trace = traceOf(run);
  trace.cfcInvocationContexts = (trace.cfcInvocationContexts ?? []).filter(
    (context) => !drop(context),
  );
};

/** Adds a file to the run's `tool-outputs/`, as a reader would have found it. */
const seedToolOutput = (
  run: RunEvidence,
  fileName: string,
  value: unknown,
): void => {
  if (run.toolOutputs.status !== "present") {
    throw new Error("the fixture's tool outputs did not load");
  }
  (run.toolOutputs.entries as ToolOutputArtifact[]).push({
    fileName,
    path: join(run.toolOutputs.path, fileName),
    value,
  });
};

/**
 * The fabric-session posture a run recorded when it ran a session at all.
 *
 * The fixture tree records none — the runs it was captured from had no
 * fabric session — so the Group C cases install one first. It is built the
 * way the harness builds it, from a session config, rather than written out
 * by hand: a hand-written record would pass these checks by agreeing with
 * the checks rather than by being what a session resolves.
 */
const CONFORMING_SESSION_POSTURE: HarnessFabricSessionCfcPosture = {
  enforcementMode: "enforce-explicit",
  enforcementModeSource: "preset-pin",
  flowLabels: "persist",
  flowLabelsSource: "posture",
  posture: "max-enforcement",
  record: harnessFabricSessionPosture({
    apiUrl: "https://fabric.test/",
    identityKeyPath: "/dev/null",
    space: "did:key:seeded",
    cfcPosture: "max-enforcement",
  }),
};

/**
 * A recorded posture as a seeding step may edit it.
 *
 * The posture record's fields are `readonly` all the way down, which is right
 * for the code that produces it and wrong here: what a violation is, is a
 * record saying something its producer would not have written.
 */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> };

/** The family with a conforming session posture installed on its root run. */
const withSessionPosture = (
  mutate: (posture: DeepMutable<HarnessFabricSessionCfcPosture>) => void,
): RunFamily =>
  seeded((root) => {
    const posture = structuredClone(
      CONFORMING_SESSION_POSTURE,
    ) as DeepMutable<HarnessFabricSessionCfcPosture>;
    mutate(posture);
    stateOf(root).fabricSessionCfc = posture;
  });

/** Every verdict of the family once a conforming session posture is installed. */
const SESSION_CLEAN = verdicts(withSessionPosture(() => {}));

/**
 * The family with the conforming posture on its root and the same posture,
 * stamped `inherited`, on every child — a delegation as the harness records
 * one, where the child runs on the session its parent built.
 */
const withInheritedChildPosture = (): RunFamily => {
  const audited = withSessionPosture(() => {});
  const parentRecord = CONFORMING_SESSION_POSTURE.record!;
  for (const child of audited.children) {
    stateOf(child).fabricSessionCfc = {
      ...structuredClone(CONFORMING_SESSION_POSTURE),
      record: inheritedCfcPostureReport(parentRecord),
    };
  }
  return audited;
};

/** The key a check's verdict on `run` is held under. */
const on = (checkId: string, runId: string): string => `${checkId}@${runId}`;

/**
 * Asserts that seeding `mutate` into the session posture turns exactly
 * `checkId`'s verdict, against the baseline where that posture is conforming.
 */
const sessionTurnsOnly = (
  checkId: string,
  expected: CheckVerdict,
  mutate: (posture: DeepMutable<HarnessFabricSessionCfcPosture>) => void,
): void => {
  expect(verdicts(withSessionPosture(mutate))).toEqual({
    ...SESSION_CLEAN,
    [at(checkId)]: expected,
  });
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
        RUN_CHECKS.filter((check) => CLEAN[at(check.id)] === undefined)
          .map((check) => check.id),
      ).toEqual([]);
    });
  });

  describe("check registration", () => {
    it("names what falsifies every check", () => {
      expect(
        RUN_CHECKS.filter((check) => check.falsifiedBy.trim() === "")
          .map((check) => check.id),
      ).toEqual([]);
    });

    it("gives every check a distinct id", () => {
      expect(new Set(RUN_CHECKS.map((check) => check.id)).size).toBe(
        RUN_CHECKS.length,
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

    it("fails a substrate-reaching side effect whose context was dropped", () => {
      // AUD-9 turns with it: the call is unattested, and what would explain
      // its result is the artifact that went missing.

      expect(verdicts(seeded((root) => {
        dropInvocationContexts(
          root,
          (context) => context.toolOutputId === SECOND_BASH_OUTPUT_ID,
        );
      }))).toEqual({
        ...CLEAN,
        [at("AUD-2")]: "fail",
        [at("AUD-9")]: "fail",
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

    it("fails a persisted tool output the run report does not list", () => {
      turnsOnly("AUD-3", "fail", (root) => {
        seedToolOutput(root, `${FIXTURE_RUN_ID}_bash_4-bash.json`, {
          outputId: `${FIXTURE_RUN_ID}:bash:4`,
          stdout: "unrecorded\n",
          stderr: "",
          exitCode: 0,
        });
      });
    });

    it("passes a run-pattern-source sidecar the run report does not list", () => {
      expect(verdicts(seeded((root) => {
        seedToolOutput(
          root,
          `${FIXTURE_RUN_ID}_run_pattern_4-run-pattern-source.json`,
          {
            type: "cf-harness.run-pattern-source",
            outputId: `${FIXTURE_RUN_ID}:run_pattern:4`,
            sourceText: "export default recipe(Input, () => ({}));",
          },
        );
      }))).toEqual(CLEAN);
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

    it("counts denials rather than defects when one denial fails twice", () => {
      const mutate = (root: RunEvidence): void => {
        const denied = reportOf(root).toolActivity.find((activity) =>
          activity.policyDecision === "denied"
        )!;
        // One denial, two defects: no policy event accounts for it, and the
        // message answering it is untyped free text.
        const state = stateOf(root);
        state.policyEvents = state.policyEvents.filter((event) =>
          event.toolCallId !== denied.toolCallId
        );
        const report = reportOf(root);
        report.policyEvents = (report.policyEvents ?? []).filter((event) =>
          event.toolCallId !== denied.toolCallId
        );
        for (const message of transcriptOf(root)) {
          if (
            message.role === "tool" && message.toolCallId === denied.toolCallId
          ) {
            message.content = "refused";
          }
        }
      };
      // The whole map, as every case in this file asserts it: a mutation that
      // also turned a neighbor's verdict would say nothing about AUD-4.
      turnsOnly("AUD-4", "fail", mutate);

      // Then the message itself, which is what this case is really about: the
      // numerator counts denials, so it cannot exceed the denominator even
      // though this one denial failed the check twice over.
      const outcome = auditRunFamily(seeded(mutate), RUN_CHECKS).find((
        result,
      ) => result.checkId === "AUD-4" && result.runId === FIXTURE_RUN_ID)!;
      expect(outcome.message).toContain("1 of 1 denial");
      expect(outcome.evidence?.length).toBe(2);
    });

    it("does not count an invalid-argument rejection as a denial", () => {
      const invalidated = (root: RunEvidence): void => {
        const trace = traceOf(root);
        const decision = trace.decisions.at(-1)!;
        decision.decision = "invalid";
        decision.reasonCodes = ["invalid_tool_call"];
        trace.decisionCounts.allowed -= 1;
        trace.decisionCounts.invalid = (trace.decisionCounts.invalid ?? 0) + 1;
        const report = reportOf(root);
        const reported = (report.policyDecisions ?? []).find((candidate) =>
          candidate.toolCallId === decision.toolCallId
        );
        if (reported !== undefined) {
          reported.decision = "invalid";
          reported.reasonCodes = ["invalid_tool_call"];
        }
        if (report.policyDecisionCounts !== undefined) {
          report.policyDecisionCounts.allowed -= 1;
          report.policyDecisionCounts.invalid =
            (report.policyDecisionCounts.invalid ?? 0) + 1;
        }
        const state = stateOf(root);
        const held = (state.policyDecisions ?? []).find((candidate) =>
          candidate.toolCallId === decision.toolCallId
        );
        if (held !== undefined) {
          held.decision = "invalid";
          held.reasonCodes = ["invalid_tool_call"];
        }
        for (const activity of report.toolActivity) {
          if (activity.toolCallId === decision.toolCallId) {
            activity.policyDecision = "invalid";
          }
        }
      };

      // A rejection the loop made over arguments it could not read reached no
      // policy question, so it owes the typed deny channel nothing.
      expect(verdicts(seeded(invalidated))).toEqual(CLEAN);
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
        const orphan = structuredClone(last);
        if (orphan.role === "tool") {
          delete orphan.resultRef;
        }
        transcript.push(orphan);
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

  describe("the conforming session posture", () => {
    it("passes the matrix and the drift check, and names the llm gap", () => {
      // The baseline the Group C cases move away from. AUD-14 is a WARN here
      // by design: the max-enforcement posture leaves the llm sinks ungated,
      // and the always-emitted finding is what publishes that rather than
      // leaving it to be inferred from a sink's absence.
      expect(SESSION_CLEAN[at("AUD-13")]).toBe("pass");
      expect(SESSION_CLEAN[at("AUD-14")]).toBe("warn");
      expect(SESSION_CLEAN[at("AUD-15")]).toBe("not-applicable");
      expect(SESSION_CLEAN[at("AUD-15a")]).toBe("pass");
    });
  });

  describe("a delegated child's inherited posture", () => {
    it("evaluates the two record-reading checks on the child rather than leaving them inconclusive", () => {
      // The child is where `run_pattern` runs, so a child recording no
      // posture record leaves the run that exercises the sinks as the one
      // whose sink registry the audit cannot establish. Inheriting the
      // parent's record is what gives these two checks something to read.
      const inherited = verdicts(withInheritedChildPosture());
      const childIds = family.children.map((child) => child.runId);
      expect(childIds.length).toBeGreaterThan(0);
      expect(inherited).toEqual({
        ...SESSION_CLEAN,
        ...Object.fromEntries(childIds.flatMap((runId) => [
          [on("AUD-13", runId), "pass"],
          [on("AUD-14", runId), "warn"],
          [on("AUD-15", runId), "not-applicable"],
          [on("AUD-15a", runId), "pass"],
        ])),
      });
    });

    it("leaves both inconclusive on a child that recorded the dials without the record", () => {
      const withoutRecord = withInheritedChildPosture();
      for (const child of withoutRecord.children) {
        delete stateOf(child).fabricSessionCfc!.record;
      }
      const verdictMap = verdicts(withoutRecord);
      for (const child of withoutRecord.children) {
        expect(verdictMap[on("AUD-13", child.runId)]).toBe("inconclusive");
        expect(verdictMap[on("AUD-14", child.runId)]).toBe("inconclusive");
      }
    });
  });

  describe("AUD-13 conforming matrix point", () => {
    it("fails a strict run whose flow labels are not persisted", () => {
      sessionTurnsOnly("AUD-13", "fail", (posture) => {
        posture.record!.enforcementMode.rung = "enforce-strict";
        posture.record!.flowLabels.rung = "off";
      });
    });

    it("warns a run whose policy evaluation only observes", () => {
      sessionTurnsOnly("AUD-13", "warn", (posture) => {
        posture.record!.policyEvaluation.rung = "observe";
      });
    });
  });

  describe("AUD-14 ungated sink coverage", () => {
    it("fails a record that publishes no deviation while a sink is ungated", () => {
      sessionTurnsOnly("AUD-14", "fail", (posture) => {
        posture.record!.deviations = [];
      });
    });

    it("retires once every known sink carries a ceiling", () => {
      sessionTurnsOnly("AUD-14", "not-applicable", (posture) => {
        posture.record!.sinks = posture.record!.sinks.map((sink) => ({
          sink: sink.sink,
          ceiling: [],
        }));
      });
    });
  });

  describe("AUD-15a default-sourced dial drift", () => {
    it("fails a default-sourced flow dial under a max-enforcement claim", () => {
      sessionTurnsOnly("AUD-15a", "fail", (posture) => {
        posture.flowLabels = "off";
        posture.flowLabelsSource = "default";
      });
    });
  });

  describe("AUD-9 evidence retention", () => {
    it("fails an enforcing run whose policy trace is gone", () => {
      turnsOnly("AUD-9", "fail", (root) => {
        root.policyTrace = { status: "absent", path: root.policyTrace.path };
      });
    });

    it("warns a run whose side effects recorded no invocation context", () => {
      // The two warns are one run read against two clauses: AUD-2 says the
      // enforcing claim went untested, and this says retention cannot be
      // confirmed, because a tree holding no context reads the same whether
      // the effects ran host-side or the evidence was lost.

      expect(verdicts(seeded((root) => {
        dropInvocationContexts(root, () => true);
      }))).toEqual({
        ...CLEAN,
        [at("AUD-2")]: "warn",
        [at("AUD-9")]: "warn",
      });
    });
  });

  describe("AUD-20 omission accounting", () => {
    it("is inconclusive when the run predates omission records", () => {
      turnsOnly("AUD-20", "inconclusive", (root) => {
        root.transcriptOmissions = {
          status: "absent",
          path: root.transcriptOmissions.path,
        };
      });
    });
  });
});

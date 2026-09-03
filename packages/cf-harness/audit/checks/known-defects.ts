/**
 * The Group E checks: the defects we have found, each written as a check that
 * fails today for a named reason and turns green when the defect is fixed.
 *
 * Group A asks whether a run did what the clauses require, and finds a
 * regression when it stops. These ask a different question, and it is the one
 * an operator actually asks: is the system still broken in the ways we already
 * know about, and is that list getting shorter? A finding here is not news.
 * Its value is the day it stops appearing.
 *
 * That makes the falsifiability discipline the whole of these checks' worth. A
 * check that only ever fails is a constant wearing a check's clothes: it
 * reports the same thing about a fixed system as about a broken one, so it can
 * never say the work landed. Every check here is therefore seeded twice in
 * `test/seeded-violations.test.ts` — once with the defect, where it fails, and
 * once with the shape a fix would produce, where it passes — and the second
 * seeding is the one that matters.
 *
 * Each names the obligation of the CFC specification's `CfcAgentHarnessProfile`
 * checklist it reports on, and the issue the work is tracked under.
 * `conformance-manifest.ts` holds the other side of that link: the obligation,
 * its status, and the checks covering it, reconciled against these verdicts so
 * a status nothing tests cannot be asserted.
 */

import type {
  HarnessSubagentRunManifest,
  HarnessSubagentRunRef,
} from "../../src/contracts/subagent.ts";

import { isDID } from "@commonfabric/identity";

import type { PromptSlotBinding } from "../../src/contracts/prompt-slot.ts";
import { extendsClause, requiredBy } from "../citations.ts";
import type { RunEvidence } from "../evidence.ts";
import type { CheckEvidence, KnownDefectRegistration } from "../report.ts";
import {
  activitiesOf,
  type AuditCheck,
  count,
  decisionsOf,
  executedSideEffects,
  isEnforcing,
  notReadable,
  runStateOf,
} from "./structural.ts";

//
// AUD-21 label-consulting admission (H9)
//

/**
 * What a ledger entry for each of these checks would say, other than the run
 * selector, which is written from the finding's own run id.
 *
 * Held beside the checks rather than inside each one so that the set is
 * readable as a register in its own right — these are the defects, and this
 * file is where the list shrinks from. A nightly audit fails on every one of
 * these until a ledger records them as known; that ledger arrives with the
 * nightly, and until then a failing Group E check is the register working
 * rather than something broken.
 */
export const KNOWN_DEFECT_REGISTRATIONS = {
  "AUD-21": {
    detail: "were admitted on authority alone",
    runShape:
      "an enforcing run whose executed side effects are sandbox tools rather than `run_pattern`",
    why:
      "H9. Every side-effecting tool except `run_pattern` is admitted by a gate on the descriptor's static `effectClass` crossed with whether the run carries direct-command evidence, recorded before the tool runs, consulting no sink, no ceiling and no label. It closes when each side-effecting tool's effect is routed through a named sink with a declared ceiling, the way `run_pattern` already routes its answer.",
    issue: "CT-2175",
  },
  "AUD-22": {
    detail: "without binding what AH-CFC-3 requires it to bind",
    runShape: "any run that binds a `direct-command` prompt slot",
    why:
      "H2. No mint site populates a `valueDigest`, and the subject is a run-scoping fact — a workspace path or a resume-run id — rather than an authenticated principal. Both halves are additive: the contract already types the fields, and the work is at the two mint sites.",
    issue: "CT-2216",
  },
  "AUD-23": {
    detail: "no confidentiality ceiling",
    runShape: "any run that delegates",
    why:
      "H8. Nothing in the subagent profile represents a ceiling, so a child that inherits a handle to a cell the parent could read can read it, whatever tools it was given. Not harness-local: the reads bottom out in the runner, so the ceiling has to be something the runner's access check can consume.",
    issue: "CT-2217",
  },
} as const satisfies Record<string, KnownDefectRegistration>;

/**
 * The side effects of a run that produced no result, and so crossed no release
 * boundary.
 *
 * A call the harness admitted and that then failed before producing a value —
 * a pattern that did not compile is the ordinary case — never reached the
 * boundary that measures what a result would release. Its allow-side decision
 * is the only one it can have, and reading that absence as an ungated path
 * reports a compile error as a missing gate.
 *
 * Read from the call's own recorded output rather than from its execution
 * status, which is `completed` for a call that ran and answered with a
 * failure.
 */
const resultlessCalls = (run: RunEvidence): ReadonlySet<string> => {
  if (run.toolOutputs.status !== "present") return new Set();
  const resultless = new Set<string>();
  const failed = new Set<string>();
  for (const entry of run.toolOutputs.entries) {
    const value = entry.value as
      | { outputId?: unknown; status?: unknown }
      | undefined;
    if (typeof value?.outputId !== "string") continue;
    if (typeof value.status === "string" && value.status !== "ok") {
      failed.add(value.outputId);
    }
  }
  for (const activity of activitiesOf(run)) {
    const outputId = activity.resultRef?.outputId;
    if (outputId !== undefined && failed.has(outputId)) {
      resultless.add(activity.toolCallId);
    }
  }
  return resultless;
};

/**
 * Whether any decision recorded for `toolCallId` consulted a label.
 *
 * The predicate is the `release` record, and it is chosen because it is the
 * only thing in an artifact tree that tells the two kinds of decision apart. A
 * boundary that measured a flow against a sink writes one; the prompt loop's
 * own gate does not, because it has nothing to write — it turns on the tool
 * descriptor's static `effectClass` crossed with whether the run carries
 * direct-command evidence, and records its verdict before the tool runs.
 *
 * Not the reason codes. Every `cfc_*` code comes from that one authority
 * switch, so counting them would report an authority allow as a label
 * consultation — the trap `AUD-16` documents at length and for the same
 * reason. Not the invocation context's `cfcInputLabels` either: labels
 * carried into a call are labels the call transported, and transporting a
 * label is not the same act as a decision turning on one.
 */
const labelConsultingDecisions = (
  run: RunEvidence,
): ReadonlySet<string> => {
  const consulted = new Set<string>();
  for (const decision of decisionsOf(run)?.decisions ?? []) {
    if (decision.release !== undefined) {
      consulted.add(decision.toolCallId);
    }
  }
  return consulted;
};

const labelConsultingAdmission: AuditCheck = {
  id: "AUD-21",
  title: "label-consulting admission",
  // The clause wants a side-effect request to carry the influence labels its
  // profile requires. It does not say the decision admitting the request must
  // turn on one, which is what this check reports, so the finding is ours and
  // says so. The clause that does state it is §18.3.3's last bullet of the
  // CFC specification, which is another repository's document and cannot be
  // quoted here under the drift test's guarantee.
  citations: extendsClause("AH-CFC-9"),
  falsifiedBy:
    "an executed side effect under an enforcing mode whose every recorded decision turns on authority — no decision on its `toolCallId` carries a `release` record, which is the only thing a boundary that consulted a label writes",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    // The side effects are in the run report, and the decisions that admitted
    // them are read from the first of trace, report and run state that loaded
    // — which the guard above established. Without the report the tool
    // activity reads as empty, and a run with no side effects passes by
    // knowing nothing about the ones it made.
    if (run.runReport.status !== "present") {
      return notReadable("run-report.json", run.runReport);
    }
    const mode = runStateOf(run)!.cfcEnforcementMode;
    const effects = executedSideEffects(run);
    if (effects.length === 0) {
      return {
        verdict: "not-applicable",
        message: "this run executed no side effect, so nothing was admitted",
      };
    }
    if (!isEnforcing(mode)) {
      return {
        verdict: "not-applicable",
        message:
          `this run claims \`${mode}\`, which admits a side effect without claiming to have decided about it`,
      };
    }
    const resultless = resultlessCalls(run);
    const measured = effects.filter((activity) =>
      !resultless.has(activity.toolCallId)
    );
    if (measured.length === 0) {
      return {
        verdict: "not-applicable",
        message: `none of this run's ${
          count(effects.length, "side effect", "side effects")
        } produced a result, so none reached a boundary that measures one`,
      };
    }
    const consulted = labelConsultingDecisions(run);
    const unconsulted = measured.filter((activity) =>
      !consulted.has(activity.toolCallId)
    );
    if (unconsulted.length === 0) {
      return {
        verdict: "pass",
        message: `every one of this run's ${
          count(measured.length, "side effect", "side effects")
        } that produced a result was admitted by a decision that consulted a label`,
      };
    }
    const byTool = new Map<string, number>();
    for (const activity of unconsulted) {
      byTool.set(activity.toolId, (byTool.get(activity.toolId) ?? 0) + 1);
    }
    const evidence: CheckEvidence[] = [...byTool.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([toolId, total]) => ({
        artifact: "run-report.json",
        pointer: "toolActivity",
        detail: `\`${toolId}\`: ${
          count(total, "executed side effect", "executed side effects")
        } admitted with no label-consulting decision`,
      }));
    return {
      verdict: "fail",
      message: `${
        count(unconsulted.length, "side effect", "side effects")
      } of ${effects.length} were admitted on authority alone, with no decision that could have consulted a label`,
      evidence,
      knownDefect: KNOWN_DEFECT_REGISTRATIONS["AUD-21"],
    };
  },
};

//
// AUD-22 prompt-slot binding (H2)
//

/** Every distinct prompt-slot binding this run's artifacts carry. */
const promptSlotBindings = (
  run: RunEvidence,
): readonly {
  where: string;
  artifact: string;
  binding: PromptSlotBinding;
}[] => {
  const found: {
    where: string;
    artifact: string;
    binding: PromptSlotBinding;
  }[] = [];
  const seen = new Set<string>();
  const add = (
    artifact: string,
    where: string,
    binding?: PromptSlotBinding,
  ) => {
    if (binding === undefined) return;
    const key = JSON.stringify(binding);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ artifact, where, binding });
  };
  add(
    "run-state.json",
    "promptSlotBinding",
    runStateOf(run)?.promptSlotBinding,
  );
  for (const activity of activitiesOf(run)) {
    add(
      "run-report.json",
      `toolActivity[${activity.sequence}].promptSlot`,
      activity.promptSlot,
    );
  }
  for (const decision of decisionsOf(run)?.decisions ?? []) {
    add(
      "policy-trace.json",
      `decisions[${decision.sequence}].promptSlot`,
      decision.promptSlot,
    );
  }
  return found;
};

/**
 * What AH-CFC-3 requires of a binding and this one does not carry.
 *
 * `subject` is read as the clause reads it — an authenticated subject — and
 * the only form of one an artifact can be held to is a DID. A workspace path
 * and a resume-run id are both run-scoping facts that occupy the field without
 * naming anybody, and a check that accepted any non-empty string would pass on
 * exactly the shape the obligation is open against.
 */
const missingBindingFields = (
  binding: PromptSlotBinding,
): readonly string[] => {
  const missing: string[] = [];
  const present = (value: unknown): boolean =>
    typeof value === "string" && value.trim() !== "";
  if (!present(binding.kernelName)) missing.push("a kernel name");
  if (!present(binding.surface)) missing.push("a named surface");
  if (!present(binding.subject)) {
    missing.push("an authenticated subject");
  } else if (!isDID(binding.subject)) {
    missing.push(
      `an authenticated subject (\`${binding.subject}\` names no principal)`,
    );
  }
  if (!present(binding.valueDigest)) {
    missing.push("a digest of the exact value carrying the authority");
  }
  return missing;
};

const promptSlotBindingEvidence: AuditCheck = {
  id: "AUD-22",
  title: "prompt-slot binding",
  citations: requiredBy("AH-CFC-3"),
  falsifiedBy:
    "a `direct-command` prompt-slot binding that carries no value digest, or whose subject is absent or is something other than a principal — a workspace path, a resume-run id, or any other run-scoping fact occupying the field",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const bindings = promptSlotBindings(run).filter(({ binding }) =>
      binding.role === "direct-command"
    );
    if (bindings.length === 0) {
      return {
        verdict: "not-applicable",
        message:
          "this run recorded no `direct-command` prompt-slot binding, so it minted no authority for a binding to carry",
      };
    }
    const evidence: CheckEvidence[] = [];
    for (const { artifact, where, binding } of bindings) {
      const missing = missingBindingFields(binding);
      if (missing.length === 0) continue;
      evidence.push({
        artifact,
        pointer: where,
        detail:
          `a \`direct-command\` binding on \`${binding.surface}\` carrying no ${
            missing.join("; no ")
          }`,
      });
    }
    if (evidence.length === 0) {
      return {
        verdict: "pass",
        message: `every one of this run's ${
          count(
            bindings.length,
            "`direct-command` binding binds",
            "`direct-command` bindings bind",
          )
        } a kernel name, an authenticated subject, a named surface and a digest of the value`,
      };
    }
    return {
      verdict: "fail",
      message: `${
        count(evidence.length, "binding mints", "bindings mint")
      } direct-command authority without binding what AH-CFC-3 requires it to bind`,
      evidence,
      knownDefect: KNOWN_DEFECT_REGISTRATIONS["AUD-22"],
    };
  },
};

//
// AUD-23 delegation ceiling (H8)
//

/**
 * The field a delegation would carry its child's confidentiality ceiling in.
 *
 * Read off the record rather than off the type, because the type has no such
 * field: nothing in `HarnessSubagentProfileConfig` represents a ceiling today,
 * which is the defect. An audit reads what a tree holds, so naming the field
 * here is what lets the check turn green the day a delegation starts writing
 * one, without an audit change landing alongside the fix.
 */
const CEILING_FIELD = "confidentialityCeiling";

const recordsCeiling = (manifest: HarnessSubagentRunManifest): boolean => {
  const value = (manifest as unknown as Record<string, unknown>)[CEILING_FIELD];
  return value !== undefined && value !== null;
};

/**
 * Every delegation this run's artifacts record, and where each was read.
 *
 * `subagentRuns` is carried by both the run state and the run report, and a
 * tree can lose either. Reading one artifact would report a run that delegated
 * as one that did not, which is the shape AUD-9's context union already had to
 * close: an absence in one place is not an absence.
 *
 * Keyed by `childRunId`, so the same delegation recorded twice counts once.
 */
const delegationsOf = (
  run: RunEvidence,
): readonly { artifact: string; delegation: HarnessSubagentRunRef }[] => {
  const byChild = new Map<
    string,
    { artifact: string; delegation: HarnessSubagentRunRef }
  >();
  const sources: [string, readonly HarnessSubagentRunRef[]][] = [
    ["run-state.json", runStateOf(run)?.subagentRuns ?? []],
    [
      "run-report.json",
      run.runReport.status === "present"
        ? run.runReport.value.subagentRuns ?? []
        : [],
    ],
  ];
  for (const [artifact, delegations] of sources) {
    for (const delegation of delegations) {
      if (!byChild.has(delegation.childRunId)) {
        byChild.set(delegation.childRunId, { artifact, delegation });
      }
    }
  }
  return [...byChild.values()];
};

/**
 * Whether the two artifacts recording delegations have diverged, as opposed to
 * one of them lagging the other.
 *
 * Containment rather than equality, and the distinction is the same one AUD-9's
 * context union turns on. Both artifacts are written from the same run state,
 * so an interrupted run leaves one a subset of the other — a write that did not
 * finish. Neither containing the other is divergence: each holds a delegation
 * the other lost, which no ordinary write order produces.
 *
 * It does not change what {@link delegationsOf} returns. The union is already
 * fail-closed for this check's own question — it can only add children whose
 * ceiling must be accounted for — so divergence is reported rather than
 * enumerated around, and its cost is that "every delegation" stops being a
 * claim this run's artifacts support.
 */
const delegationsDiverge = (run: RunEvidence): boolean => {
  if (run.runReport.status !== "present") {
    return false;
  }
  const childrenOf = (
    delegations: readonly HarnessSubagentRunRef[] | undefined,
  ): ReadonlySet<string> =>
    new Set((delegations ?? []).map((delegation) => delegation.childRunId));
  const state = childrenOf(runStateOf(run)?.subagentRuns);
  const report = childrenOf(run.runReport.value.subagentRuns);
  const contains = (
    bigger: ReadonlySet<string>,
    smaller: ReadonlySet<string>,
  ): boolean => [...smaller].every((child) => bigger.has(child));
  return !contains(state, report) && !contains(report, state);
};

const delegationCeiling: AuditCheck = {
  id: "AUD-23",
  title: "delegation ceiling",
  citations: requiredBy("AH-CFC-12a"),
  falsifiedBy:
    "a delegation whose recorded manifest carries no confidentiality ceiling — which is every delegation today, because nothing in the subagent profile represents one — and, as a warning that weakens a clean answer, two artifacts that have each lost a delegation the other kept",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const delegations = delegationsOf(run);
    const diverged = delegationsDiverge(run);
    const divergence: readonly CheckEvidence[] = diverged
      ? [{
        artifact: "run-state.json",
        pointer: "subagentRuns",
        detail:
          "`run-report.json` records a delegation this does not, and the reverse — each artifact has lost a child the other kept, so this may not be every delegation",
      }]
      : [];
    if (delegations.length === 0) {
      return {
        verdict: "not-applicable",
        message: "this run delegated nothing, so no child profile arises",
      };
    }
    const uncapped = delegations.filter(({ delegation }) =>
      !recordsCeiling(delegation.manifest)
    );
    if (uncapped.length === 0) {
      // A bare `pass` would claim every delegation bound a ceiling. Where the
      // artifacts have diverged this run cannot say what every delegation was,
      // so the claim is weakened rather than made.
      return diverged
        ? {
          verdict: "warn",
          message:
            `every delegation these artifacts still record bound its child a confidentiality ceiling, but they have diverged about which delegations happened, so that is not a claim about all of them`,
          evidence: divergence,
        }
        : {
          verdict: "pass",
          message: `every one of this run's ${
            count(delegations.length, "delegation", "delegations")
          } bound its child a confidentiality ceiling`,
        };
    }
    // AH-CFC-12a states the ceiling as a SHOULD, so the finding carries the
    // clause's own weight rather than one chosen to look urgent. The nightly
    // audit runs at `--fail-on warn`, so this is a failing job either way, and
    // a reader comparing the finding to the clause finds them agreeing.
    return {
      verdict: "warn",
      message: `${
        count(uncapped.length, "delegation records", "delegations record")
      } no confidentiality ceiling, so nothing bounds what the child may observe through the handles and arguments it inherits`,
      knownDefect: KNOWN_DEFECT_REGISTRATIONS["AUD-23"],
      evidence: [
        ...uncapped.map(({ artifact, delegation }) => ({
          artifact,
          pointer: `subagentRuns[${delegation.childRunId}].manifest`,
          detail:
            `the \`${delegation.manifest.profile}\` profile binds tools, skills and a turn budget, and no \`${CEILING_FIELD}\``,
        })),
        ...divergence,
      ],
    };
  },
};

/** Every known-defect check, in id order. */
export const KNOWN_DEFECT_CHECKS: readonly AuditCheck[] = [
  labelConsultingAdmission,
  promptSlotBindingEvidence,
  delegationCeiling,
];

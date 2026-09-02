/**
 * The Group A checks: what one run's own artifacts say about the CFC clauses
 * the harness answers to.
 *
 * Each check is an expression of the clauses it cites and of nothing else. It
 * reads only the artifact tree — no live runtime, no space database, no
 * network — so what it can establish is bounded by what the run wrote down,
 * and it says so: an artifact the check needs and did not find makes the
 * check `inconclusive`, never `pass`.
 *
 * Every check declares what falsifies it. A check nothing could falsify is a
 * sentence about the specification rather than a test of an implementation,
 * and `test/seeded-violations.test.ts` holds each one to its declaration by
 * seeding exactly that shape and requiring the verdict to turn.
 */

import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";

import { handleTokensIn } from "../../console/steps.ts";
import type { HarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import type { HarnessCfcModelContext } from "../../src/contracts/cfc-model-context.ts";
import type { HarnessHandleTable } from "../../src/contracts/handle-table.ts";
import type { HarnessPolicyEvent } from "../../src/contracts/policy.ts";
import {
  countHarnessPolicyDecisions,
  type HarnessPolicyDecisionCounts,
  type HarnessPolicyDecisionReasonCode,
  type HarnessPolicyDecisionRecord,
} from "../../src/contracts/policy-trace.ts";
import type { HarnessToolActivity } from "../../src/contracts/run-report.ts";
import type {
  HarnessToolTranscriptMessage,
  HarnessTranscriptMessage,
} from "../../src/contracts/transcript.ts";
import { inspectHarnessTranscriptPairing } from "../../src/contracts/transcript.ts";
import { assertValidHarnessHandleTable } from "../../src/handle-table.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import { citationsFor, type SpecCitation } from "../citations.ts";
import {
  type ArtifactState,
  familyRuns,
  type RunEvidence,
  type RunFamily,
} from "../evidence.ts";
import type { CheckEvidence, CheckResult, CheckVerdict } from "../report.ts";

/** What a check found, before it is stamped with the run it looked at. */
export interface CheckOutcome {
  verdict: CheckVerdict;
  message: string;
  evidence?: readonly CheckEvidence[];
}

/** One registered check. */
export interface AuditCheck {
  /** Stable id, cited in findings and in the seeded-violation suite. */
  id: string;

  /** What the check is about, in two or three words. */
  title: string;

  citations: readonly SpecCitation[];

  /**
   * What in an artifact tree makes this check report `fail`.
   *
   * A registration is where a reader learns whether the check can fail at
   * all, so this names the evidence rather than restating the rule: "a
   * decision record whose mode differs from the run's", not "the mode is
   * consistent".
   */
  falsifiedBy: string;

  inspect(run: RunEvidence, family: RunFamily): CheckOutcome;
}

//
// Reading the evidence
//

/** An artifact this host did not find, or found and could not read. */
type UnreadableArtifact = Exclude<
  ArtifactState<unknown>,
  { status: "present" }
>;

/** The outcome for a check whose subject artifact was not readable. */
const notReadable = (
  artifact: string,
  state: UnreadableArtifact,
): CheckOutcome => ({
  verdict: "inconclusive",
  message: state.status === "absent"
    ? `\`${artifact}\` is absent, so nothing about this clause was established`
    : `\`${artifact}\` ${state.detail}, so nothing about this clause was established`,
  evidence: [{ artifact, detail: state.status }],
});

const runStateOf = (run: RunEvidence): HarnessRunState | undefined =>
  run.runState.status === "present" ? run.runState.value : undefined;

/**
 * The run's policy decisions, and which artifact they were read from.
 *
 * The trace is the artifact whose subject they are; the report and the run
 * state carry the same list, so a tree missing the trace can still be read.
 */
const decisionsOf = (
  run: RunEvidence,
):
  | { source: string; decisions: readonly HarnessPolicyDecisionRecord[] }
  | undefined => {
  if (run.policyTrace.status === "present") {
    return {
      source: "policy-trace.json",
      decisions: run.policyTrace.value.decisions ?? [],
    };
  }
  if (run.runReport.status === "present") {
    return {
      source: "run-report.json",
      decisions: run.runReport.value.policyDecisions ?? [],
    };
  }
  const state = runStateOf(run);
  return state === undefined
    ? undefined
    : { source: "run-state.json", decisions: state.policyDecisions ?? [] };
};

const activitiesOf = (run: RunEvidence): readonly HarnessToolActivity[] =>
  run.runReport.status === "present"
    ? run.runReport.value.toolActivity ?? []
    : [];

const policyEventsOf = (run: RunEvidence): readonly HarnessPolicyEvent[] =>
  run.runReport.status === "present"
    ? run.runReport.value.policyEvents ?? []
    : runStateOf(run)?.policyEvents ?? [];

const invocationContextsOf = (
  run: RunEvidence,
): readonly HarnessCfcInvocationContext[] => {
  if (run.policyTrace.status === "present") {
    const contexts = run.policyTrace.value.cfcInvocationContexts;
    if (contexts !== undefined && contexts.length > 0) {
      return contexts;
    }
  }
  return runStateOf(run)?.cfcInvocationContexts ?? [];
};

const transcriptOf = (
  run: RunEvidence,
): readonly HarnessTranscriptMessage[] | undefined =>
  run.transcript.status === "present" ? run.transcript.value : undefined;

const modelContextOf = (
  run: RunEvidence,
): HarnessCfcModelContext | undefined => runStateOf(run)?.cfcModelContext;

const handleTableOf = (run: RunEvidence): HarnessHandleTable | undefined =>
  runStateOf(run)?.handleTable;

const isEnforcing = (mode: CfcEnforcementMode): boolean =>
  mode === "enforce-explicit" || mode === "enforce-strict";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A tool message's parsed contents, or `undefined` when it is not JSON. */
const parsedToolContent = (message: HarnessToolTranscriptMessage): unknown => {
  try {
    return JSON.parse(message.content);
  } catch {
    return undefined;
  }
};

/** The number, and the singular or plural word for it. */
const count = (total: number, singular: string, plural: string): string =>
  `${total} ${total === 1 ? singular : plural}`;

//
// AUD-1 posture consistency
//

/** One place in the tree that states which mode the run was under. */
interface ModeClaim {
  artifact: string;
  where: string;
  mode: CfcEnforcementMode;
}

const modeClaims = (run: RunEvidence): readonly ModeClaim[] => {
  const claims: ModeClaim[] = [];
  const state = runStateOf(run);
  if (state?.cfcEnforcementMode !== undefined) {
    claims.push({
      artifact: "run-state.json",
      where: "cfcEnforcementMode",
      mode: state.cfcEnforcementMode,
    });
  }
  if (run.policyTrace.status === "present") {
    const trace = run.policyTrace.value;
    if (trace.cfcEnforcementMode !== undefined) {
      claims.push({
        artifact: "policy-trace.json",
        where: "cfcEnforcementMode",
        mode: trace.cfcEnforcementMode,
      });
    }
    for (const decision of trace.decisions ?? []) {
      if (decision.cfcEnforcementMode !== undefined) {
        claims.push({
          artifact: "policy-trace.json",
          where: `decisions[${decision.sequence}].cfcEnforcementMode`,
          mode: decision.cfcEnforcementMode,
        });
      }
    }
  }
  if (run.runReport.status === "present") {
    const report = run.runReport.value;
    if (report.cfcEnforcementMode !== undefined) {
      claims.push({
        artifact: "run-report.json",
        where: "cfcEnforcementMode",
        mode: report.cfcEnforcementMode,
      });
    }
    for (const decision of report.policyDecisions ?? []) {
      if (decision.cfcEnforcementMode !== undefined) {
        claims.push({
          artifact: "run-report.json",
          where: `policyDecisions[${decision.sequence}].cfcEnforcementMode`,
          mode: decision.cfcEnforcementMode,
        });
      }
    }
  }
  return claims;
};

/** How the run came by its mode, for a finding to name beside the mode. */
const modeSourceOf = (run: RunEvidence): string => {
  const fabric = runStateOf(run)?.fabricSessionCfc;
  return fabric === undefined
    ? "run configuration"
    : `fabric session (${fabric.enforcementModeSource})`;
};

const postureConsistency: AuditCheck = {
  id: "AUD-1",
  title: "posture consistency",
  citations: citationsFor("AH-CFC-14"),
  falsifiedBy:
    "two artifacts of one run naming different enforcement modes — a run state, policy-trace header, run report, or any policy decision record disagreeing with the rest",
  inspect(run) {
    const claims = modeClaims(run);
    if (claims.length === 0) {
      return {
        verdict: "inconclusive",
        message:
          "no artifact of this run states an enforcement mode, so its posture is unknown",
        evidence: [{ artifact: "run-state.json", detail: run.runState.status }],
      };
    }
    const modes = new Set(claims.map((claim) => claim.mode));
    if (modes.size > 1) {
      return {
        verdict: "fail",
        message: `this run's artifacts name ${
          count(modes.size, "enforcement mode", "different enforcement modes")
        } (${[...modes].sort().join(", ")})`,
        evidence: claims.map((claim) => ({
          artifact: claim.artifact,
          pointer: claim.where,
          detail: claim.mode,
        })),
      };
    }
    const [mode] = [...modes];
    return {
      verdict: "pass",
      message: `every artifact of this run names \`${mode}\`, selected by ${
        modeSourceOf(run)
      }`,
      evidence: [{
        artifact: "run-state.json",
        pointer: "cfcEnforcementMode",
        detail: `${mode}, agreed by ${
          count(claims.length, "recorded claim", "recorded claims")
        }`,
      }],
    };
  },
};

//
// AUD-2 mode-behavior attestation
//

/**
 * The mode a reason code belongs to, or `undefined` for one that says nothing
 * about the mode.
 *
 * `HarnessPolicyDecisionReasonCode` is a closed union whose CFC members carry
 * their mode in the name, which is what makes this exact rather than
 * heuristic. A code with no mode in it — `tool_not_allowed`,
 * `subagent_profile_allowed` — is mode-neutral and asserts nothing here.
 */
const modeOfReasonCode = (
  code: HarnessPolicyDecisionReasonCode | string,
): CfcEnforcementMode | undefined => {
  const body = code.startsWith("write_file_")
    ? code.slice("write_file_".length)
    : code.startsWith("cfc_")
    ? code.slice("cfc_".length)
    : undefined;
  if (body === undefined) return undefined;
  if (body === "disabled") return "disabled";
  if (body.startsWith("observe")) return "observe";
  if (body.startsWith("enforce_explicit")) return "enforce-explicit";
  if (body.startsWith("enforce_strict")) return "enforce-strict";
  return undefined;
};

/** The side effects this run actually executed, which need transport evidence. */
const executedSideEffects = (
  run: RunEvidence,
): readonly HarnessToolActivity[] =>
  activitiesOf(run).filter((activity) =>
    activity.effectClass === "side-effect" &&
    activity.executionStatus === "completed"
  );

const modeBehaviorAttestation: AuditCheck = {
  id: "AUD-2",
  title: "mode-behavior attestation",
  citations: citationsFor("AH-CFC-14", "AH-CFC-15"),
  falsifiedBy:
    "a decision reason code from another mode's family than the run claims — a `cfc_observe_*` or `cfc_disabled` code under an enforcing claim — or a call to a tool this run elsewhere recorded an invocation context for, made with none",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    // `decisionsOf` reads the first of policy trace, run report, and run state
    // that loaded, and the guard above established one of them, so it answers
    // here rather than returning nothing.
    const found = decisionsOf(run)!;
    const mode = runStateOf(run)!.cfcEnforcementMode;
    const evidence: CheckEvidence[] = [];
    for (const decision of found.decisions) {
      for (const code of decision.reasonCodes ?? []) {
        const codeMode = modeOfReasonCode(code);
        if (codeMode !== undefined && codeMode !== mode) {
          evidence.push({
            artifact: found.source,
            pointer: `decisions[${decision.sequence}].reasonCodes`,
            detail:
              `\`${code}\` belongs to \`${codeMode}\`, and this run claims \`${mode}\``,
          });
        }
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(
            evidence.length,
            "decision reason code names",
            "decision reason codes name",
          )
        } a mode other than the \`${mode}\` this run claims`,
        evidence,
      };
    }
    const contexts = invocationContextsOf(run);
    const effects = executedSideEffects(run);
    if (!isEnforcing(mode)) {
      return {
        verdict: "pass",
        message: `every decision reason code belongs to \`${mode}\``,
      };
    }
    // Which tools reach the substrate is not something an artifact tree
    // states, so it is read off the run itself: a tool the run recorded a
    // context for is a tool whose invocations carry CFC evidence, and a later
    // call to it that carries none is evidence gone missing rather than a
    // tool that never had any.
    const transporting = new Set(contexts.map((context) => context.toolId));
    const covered = new Set(
      contexts
        .map((context) => context.toolOutputId)
        .filter((outputId) => outputId !== undefined)
        .map(String),
    );
    const uncovered = effects.filter((activity) =>
      transporting.has(activity.toolId) &&
      activity.resultRef !== undefined &&
      !covered.has(String(activity.resultRef.outputId))
    );
    if (uncovered.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(uncovered.length, "side effect", "side effects")
        } used a tool this run transports CFC evidence for, and recorded none`,
        evidence: uncovered.map((activity) => ({
          artifact: "run-report.json",
          pointer: `toolActivity[${activity.sequence}]`,
          detail: `\`${activity.toolId}\` completed with no invocation context`,
        })),
      };
    }
    if (contexts.length === 0 && effects.length > 0) {
      return {
        verdict: "warn",
        message:
          `reduced assurance: this run claims \`${mode}\` and never exercised it — none of its ${
            count(effects.length, "side effect", "side effects")
          } reached the substrate that carries CFC evidence, so nothing here tested the claim`,
        evidence: effects.map((activity) => ({
          artifact: "run-report.json",
          pointer: `toolActivity[${activity.sequence}]`,
          detail: `\`${activity.toolId}\` completed with no invocation context`,
        })),
      };
    }
    return {
      verdict: "pass",
      message: `every decision reason code belongs to \`${mode}\`, and ${
        contexts.length === 0
          ? "it made no substrate invocation"
          : `its substrate invocations carry ${
            count(contexts.length, "invocation context", "invocation contexts")
          }`
      }`,
    };
  },
};

//
// AUD-3 decision coverage
//

/**
 * The record a delegation writes into its child's `tool-outputs/` holding the
 * child's final text.
 *
 * It is the trusted side's own validation evidence rather than the result of
 * a tool the model called, so it joins to no tool activity, and its absence
 * from the report's `toolOutputs` is not an unrecorded effect.
 */
const SUBAGENT_RAW_RETURN_TYPE = "cf-harness.subagent-raw-return";

const countsAgree = (
  declared: HarnessPolicyDecisionCounts | undefined,
  computed: HarnessPolicyDecisionCounts,
): boolean =>
  declared !== undefined &&
  declared.total === computed.total &&
  declared.allowed === computed.allowed &&
  declared.warned === computed.warned &&
  declared.denied === computed.denied;

const describeCounts = (counts: HarnessPolicyDecisionCounts): string =>
  `total ${counts.total}, allowed ${counts.allowed}, warned ${counts.warned}, denied ${counts.denied}`;

const decisionCoverage: AuditCheck = {
  id: "AUD-3",
  title: "decision coverage",
  citations: citationsFor("AH-CFC-9", "AH-CFC-11", "AH-TOOL-3"),
  falsifiedBy:
    "a side-effect tool activity with no policy decision on its `toolCallId`, a declared decision count that does not match the decisions beside it, or a persisted tool output no activity accounts for",
  inspect(run) {
    if (run.runReport.status !== "present") {
      return notReadable("run-report.json", run.runReport);
    }
    const report = run.runReport.value;
    // `decisionsOf` reads the first of policy trace, run report, and run state
    // that loaded, and the guard above established one of them, so it answers
    // here rather than returning nothing.
    const found = decisionsOf(run)!;
    const evidence: CheckEvidence[] = [];
    const decided = new Set(
      found.decisions.map((decision) => decision.toolCallId),
    );
    for (const activity of report.toolActivity ?? []) {
      if (
        activity.effectClass === "side-effect" &&
        !decided.has(activity.toolCallId)
      ) {
        evidence.push({
          artifact: "run-report.json",
          pointer: `toolActivity[${activity.sequence}]`,
          detail:
            `side-effect call \`${activity.toolId}\` (${activity.toolCallId}) joins to no policy decision`,
        });
      }
    }
    const computed = countHarnessPolicyDecisions(found.decisions);
    if (run.policyTrace.status === "present") {
      const declared = run.policyTrace.value.decisionCounts;
      if (!countsAgree(declared, computed)) {
        evidence.push({
          artifact: "policy-trace.json",
          pointer: "decisionCounts",
          detail: `declares ${
            declared === undefined ? "no counts" : describeCounts(declared)
          }; its decisions are ${describeCounts(computed)}`,
        });
      }
    }
    const reportCounts = countHarnessPolicyDecisions(
      report.policyDecisions ?? [],
    );
    if (!countsAgree(report.policyDecisionCounts, reportCounts)) {
      evidence.push({
        artifact: "run-report.json",
        pointer: "policyDecisionCounts",
        detail: `declares ${
          report.policyDecisionCounts === undefined
            ? "no counts"
            : describeCounts(report.policyDecisionCounts)
        }; its decisions are ${describeCounts(reportCounts)}`,
      });
    }
    const activityOutputIds = new Set(
      (report.toolActivity ?? [])
        .map((activity) => activity.resultRef?.outputId)
        .filter((outputId) => outputId !== undefined)
        .map(String),
    );
    for (const output of report.toolOutputs ?? []) {
      if (!activityOutputIds.has(String(output.outputId))) {
        evidence.push({
          artifact: "run-report.json",
          pointer: `toolOutputs ${String(output.outputId)}`,
          detail:
            `a persisted output of \`${output.toolId}\` that no tool activity accounts for`,
        });
      }
    }
    if (run.toolOutputs.status === "present") {
      const listed = new Set(
        (report.toolOutputs ?? []).map((output) =>
          output.artifactPath?.split("/").at(-1) ?? ""
        ),
      );
      for (const entry of run.toolOutputs.entries) {
        if (listed.has(entry.fileName)) continue;
        if (
          isRecord(entry.value) && entry.value.type === SUBAGENT_RAW_RETURN_TYPE
        ) {
          continue;
        }
        evidence.push({
          artifact: `tool-outputs/${entry.fileName}`,
          detail:
            "a tool output on disk that the run report's `toolOutputs` does not list",
        });
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(evidence.length, "tool effect is", "tool effects are")
        } not accounted for by a recorded policy decision`,
        evidence,
      };
    }
    return {
      verdict: "pass",
      message:
        `every side-effect activity joins to a decision, and the declared counts match the decisions recorded (${
          describeCounts(computed)
        })`,
    };
  },
};

//
// AUD-4 denial channel
//

/** A `toolCallId` this run denied, and where the denial was recorded. */
interface DenialRecord {
  toolCallId: string;
  artifact: string;
  pointer: string;
}

/**
 * Every denial the run recorded, wherever it recorded it.
 *
 * A decision record, a tool activity, and a policy event each carry one, and
 * they are not the same set: a call the policy allowed can still have its
 * observation denied afterwards for want of mediation metadata, and that
 * denial reaches only the activity and the event. Reading all three is what
 * keeps such a call inside this check.
 */
const denialsOf = (run: RunEvidence): readonly DenialRecord[] => {
  const denials = new Map<string, DenialRecord>();
  const remember = (record: DenialRecord): void => {
    if (!denials.has(record.toolCallId)) {
      denials.set(record.toolCallId, record);
    }
  };
  const found = decisionsOf(run);
  for (const decision of found?.decisions ?? []) {
    if (decision.decision === "denied") {
      remember({
        toolCallId: decision.toolCallId,
        artifact: found!.source,
        pointer: `decisions[${decision.sequence}]`,
      });
    }
  }
  for (const activity of activitiesOf(run)) {
    if (activity.policyDecision === "denied") {
      remember({
        toolCallId: activity.toolCallId,
        artifact: "run-report.json",
        pointer: `toolActivity[${activity.sequence}]`,
      });
    }
  }
  for (const [index, event] of policyEventsOf(run).entries()) {
    if (event.severity === "denied" && event.toolCallId !== undefined) {
      remember({
        toolCallId: event.toolCallId,
        artifact: "run-report.json",
        pointer: `policyEvents[${index}]`,
      });
    }
  }
  return [...denials.values()];
};

/** The typed shape a withheld observation reaches the model as. */
const OBSERVATION_DENIED_TYPE = "cf-harness.observation-denied";

/**
 * The fields that carry an observation's own bytes.
 *
 * A typed denial names a reason, a detail, and an opaque handle standing in
 * for what was withheld. Any of these beside it is the payload arriving
 * through the channel that was meant to withhold it.
 */
const PAYLOAD_FIELDS: readonly string[] = [
  "stdout",
  "stderr",
  "content",
  "diff",
  "text",
];

/** What is wrong with the message answering a denied call, if anything. */
const deniedMessageDefect = (
  message: HarnessToolTranscriptMessage,
): string | undefined => {
  const parsed = parsedToolContent(message);
  if (!isRecord(parsed)) {
    return "carries free text rather than a typed denial";
  }
  const typed = parsed.type === OBSERVATION_DENIED_TYPE ||
    parsed.status === "error" || isRecord(parsed.error);
  if (!typed) {
    return `carries \`${
      typeof parsed.type === "string" ? parsed.type : "an untyped object"
    }\` rather than a typed denial`;
  }
  const carried = PAYLOAD_FIELDS.filter((field) => {
    const value = parsed[field];
    return typeof value === "string" && value.length > 0;
  });
  return carried.length === 0
    ? undefined
    : `carries payload content in \`${carried.join("`, `")}\``;
};

const denialChannel: AuditCheck = {
  id: "AUD-4",
  title: "denial channel",
  citations: citationsFor("AH-CFC-6", "AH-CFC-11"),
  falsifiedBy:
    "a denied `toolCallId` whose tool message is untyped free text, carries the withheld observation's payload beside the denial, or is absent from the transcript altogether",
  inspect(run) {
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    const denials = denialsOf(run);
    if (denials.length === 0) {
      return { verdict: "not-applicable", message: "this run denied nothing" };
    }
    const answered = new Map<string, [number, HarnessToolTranscriptMessage]>();
    for (const [index, message] of run.transcript.value.entries()) {
      if (message.role === "tool") {
        answered.set(message.toolCallId, [index, message]);
      }
    }
    const evidence: CheckEvidence[] = [];
    for (const denial of denials) {
      const paired = answered.get(denial.toolCallId);
      if (paired === undefined) {
        evidence.push({
          artifact: denial.artifact,
          pointer: denial.pointer,
          detail:
            `denied \`${denial.toolCallId}\`, which no tool message in the transcript pairs with`,
        });
        continue;
      }
      const [index, message] = paired;
      const defect = deniedMessageDefect(message);
      if (defect !== undefined) {
        evidence.push({
          artifact: "transcript.json",
          pointer: `[${index}]`,
          detail:
            `the message answering denied \`${denial.toolCallId}\` ${defect}`,
        });
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${evidence.length} of ${
          count(denials.length, "denial", "denials")
        } did not reach the model through the typed deny channel`,
        evidence,
      };
    }
    return {
      verdict: "pass",
      message: `${
        count(denials.length, "denial", "denials")
      } reached the model as a typed denial carrying no payload`,
    };
  },
};

//
// AUD-5 handle discipline
//

/** Where a handle token appeared, and which side of the boundary wrote it. */
interface TokenAppearance {
  index: number;
  author: "harness" | "model";
  where: string;
}

/**
 * Every handle token appearance in a transcript, in order.
 *
 * The system prompt and a tool result are the harness writing to the model; an
 * assistant message and the arguments of the calls it carries are the model
 * writing back. That split is what makes a pre-mint token legible: a token the
 * model wrote before the harness ever showed it one is a token it did not get
 * from a mint.
 */
const tokenAppearances = (
  transcript: readonly HarnessTranscriptMessage[],
): Map<string, TokenAppearance[]> => {
  const appearances = new Map<string, TokenAppearance[]>();
  const record = (token: string, appearance: TokenAppearance): void => {
    const held = appearances.get(token);
    if (held === undefined) {
      appearances.set(token, [appearance]);
    } else {
      held.push(appearance);
    }
  };
  for (const [index, message] of transcript.entries()) {
    switch (message.role) {
      case "system":
      case "user":
        for (const token of handleTokensIn(message.content)) {
          record(token, { index, author: "harness", where: message.role });
        }
        break;
      case "tool":
        for (const token of handleTokensIn(message.content)) {
          record(token, { index, author: "harness", where: "tool result" });
        }
        break;
      case "assistant":
        for (const token of handleTokensIn(message.content)) {
          record(token, { index, author: "model", where: "assistant text" });
        }
        for (const call of message.toolCalls ?? []) {
          for (const token of handleTokensIn(call.function.arguments)) {
            record(token, {
              index,
              author: "model",
              where: `\`${call.function.name}\` arguments`,
            });
          }
        }
        break;
    }
  }
  return appearances;
};

/** The tokens each delegation named, keyed by the child run it started. */
const delegatedTokens = (
  parent: RunEvidence,
): Map<string, ReadonlySet<string>> => {
  const argumentsByCall = new Map<string, string>();
  for (const message of transcriptOf(parent) ?? []) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      argumentsByCall.set(call.id, call.function.arguments);
    }
  }
  const byChild = new Map<string, ReadonlySet<string>>();
  for (const subagentRun of runStateOf(parent)?.subagentRuns ?? []) {
    const args = argumentsByCall.get(subagentRun.parentToolCallId);
    byChild.set(
      subagentRun.childRunId,
      new Set(args === undefined ? [] : handleTokensIn(args)),
    );
  }
  return byChild;
};

const handleDiscipline: AuditCheck = {
  id: "AUD-5",
  title: "handle discipline",
  citations: citationsFor("AH-CFC-18", "AH-CFC-19", "AH-CFC-12", "AH-CFC-13"),
  falsifiedBy:
    "a handle table `assertValidHarnessHandleTable` refuses, a token the model wrote before the harness disclosed it, or a parent token in a child transcript that no delegation named and the child's own table does not hold",
  inspect(run, family) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    const table = handleTableOf(run);
    const appearances = tokenAppearances(run.transcript.value);
    if (table === undefined && appearances.size === 0) {
      return {
        verdict: "not-applicable",
        message: "this run minted no handle and its transcript carries none",
      };
    }
    const evidence: CheckEvidence[] = [];
    if (table !== undefined) {
      try {
        assertValidHarnessHandleTable(table);
      } catch (error) {
        evidence.push({
          artifact: "run-state.json",
          pointer: "handleTable",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const held = new Set((table?.entries ?? []).map((entry) => entry.token));
    // An input cell's token is minted before the run's first turn and reaches
    // the model through the seeded prompt, which is not part of the recorded
    // transcript. It has no disclosure to be earlier than.
    const seeded = new Set(
      (runStateOf(run)?.inputCells ?? []).map((cell) => cell.token),
    );
    for (const [token, where] of appearances) {
      if (!held.has(token) || seeded.has(token)) continue;
      const disclosed = where.find((one) => one.author === "harness");
      const written = where.find((one) => one.author === "model");
      if (
        written !== undefined &&
        (disclosed === undefined || written.index < disclosed.index)
      ) {
        evidence.push({
          artifact: "transcript.json",
          pointer: `[${written.index}]`,
          detail:
            `\`${token}\` reaches the model's ${written.where} before the harness disclosed it`,
        });
      }
    }
    if (run.runDir === family.root.runDir) {
      const delegations = delegatedTokens(run);
      for (const child of family.children) {
        const childTranscript = transcriptOf(child);
        if (childTranscript === undefined) continue;
        const childHeld = new Set(
          (handleTableOf(child)?.entries ?? []).map((entry) => entry.token),
        );
        const named = delegations.get(child.runId) ?? new Set<string>();
        for (const token of tokenAppearances(childTranscript).keys()) {
          if (held.has(token) && !childHeld.has(token) && !named.has(token)) {
            evidence.push({
              artifact: `${child.runId}/transcript.json`,
              detail:
                `\`${token}\` is a parent handle the child carries with no recorded transfer`,
            });
          }
        }
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(evidence.length, "handle defect", "handle defects")
        } in this run's table, disclosure order, or delegation boundary`,
        evidence,
      };
    }
    return {
      verdict: "pass",
      message: `the handle table is well formed, and its ${
        count(held.size, "token", "tokens")
      } reached the model only after the harness disclosed them`,
    };
  },
};

//
// AUD-6 transcript pairing
//

const transcriptPairing: AuditCheck = {
  id: "AUD-6",
  title: "transcript pairing",
  citations: citationsFor("AH-CFC-16", "AH-LIFE-6"),
  falsifiedBy:
    "a transcript `inspectHarnessTranscriptPairing` reports a defect in — an orphan or duplicate tool result, a duplicate tool call, or a call left unanswered",
  inspect(run) {
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    const pairing = inspectHarnessTranscriptPairing(run.transcript.value);
    if (pairing.valid) {
      return {
        verdict: "pass",
        message:
          "every tool call in the transcript has exactly one matching tool result",
      };
    }
    return {
      verdict: "fail",
      message: `the transcript carries ${
        count(pairing.defects.length, "pairing defect", "pairing defects")
      }; its longest resumable prefix ends at message ${pairing.safeBoundary}`,
      evidence: pairing.defects.map((defect) => ({
        artifact: "transcript.json",
        pointer: `[${defect.messageIndex}]`,
        detail: defect.kind === "unresolved_tool_calls"
          ? `${defect.kind}: ${defect.toolCallIds.join(", ")}`
          : `${defect.kind}: ${defect.toolCallId}`,
      })),
    };
  },
};

//
// AUD-7 observe disclosure
//

const observeDisclosure: AuditCheck = {
  id: "AUD-7",
  title: "observe disclosure",
  citations: citationsFor("AH-CFC-modes-observe", "AH-CFC-15"),
  falsifiedBy:
    "a run one artifact records as `observe` while another records it as enforcing — the shape that lets a diagnostic run be reported as enforcement",
  inspect(run) {
    const claims = modeClaims(run);
    if (claims.length === 0) {
      return {
        verdict: "inconclusive",
        message:
          "no artifact of this run states an enforcement mode, so whether it was diagnostic is unknown",
      };
    }
    const observing = claims.filter((claim) => claim.mode === "observe");
    const enforcing = claims.filter((claim) => isEnforcing(claim.mode));
    if (observing.length > 0 && enforcing.length > 0) {
      return {
        verdict: "fail",
        message:
          "this run is recorded as `observe` in one artifact and as enforcing in another, so its evidence can be read as enforcement it never performed",
        evidence: [...observing, ...enforcing].map((claim) => ({
          artifact: claim.artifact,
          pointer: claim.where,
          detail: claim.mode,
        })),
      };
    }
    if (observing.length > 0) {
      return {
        verdict: "warn",
        message:
          "reduced assurance: this run was under `observe`, which is diagnostic, so its evidence attests no enforcement",
        evidence: observing.map((claim) => ({
          artifact: claim.artifact,
          pointer: claim.where,
          detail: claim.mode,
        })),
      };
    }
    if (runStateOf(run)?.fabricSessionCfc?.flowLabels === "observe") {
      return {
        verdict: "warn",
        message:
          "reduced assurance: this run's fabric session held flow labels at `observe`, so label propagation was diagnostic even where tool policy was enforcing",
        evidence: [{
          artifact: "run-state.json",
          pointer: "fabricSessionCfc.flowLabels",
          detail: "observe",
        }],
      };
    }
    return {
      verdict: "pass",
      message: "no dial this run recorded stands at `observe`",
    };
  },
};

//
// AUD-8 influence accumulation
//

/** One channel of one tool result, as the model-facing output summarized it. */
interface ChannelSummary {
  channel: string;
  policy: string;
  labeled: boolean;
}

/**
 * The per-channel CFC dispositions a mediated tool result carries.
 *
 * The model-facing output states each channel's policy and label beside the
 * text it let through, so the transcript alone says which observations the
 * model read under a confidentiality label — which is what makes the
 * accumulation rule checkable from artifacts.
 */
const channelSummaries = (parsed: unknown): readonly ChannelSummary[] => {
  if (!isRecord(parsed) || !isRecord(parsed.cfc)) return [];
  const summaries: ChannelSummary[] = [];
  for (const [key, value] of Object.entries(parsed.cfc)) {
    if (!isRecord(value) || typeof value.policy !== "string") continue;
    const label = isRecord(value.label) ? value.label : undefined;
    summaries.push({
      channel: typeof value.channel === "string" ? value.channel : key,
      policy: value.policy,
      labeled: Array.isArray(label?.confidentiality) &&
        label.confidentiality.length > 0,
    });
  }
  return summaries;
};

const influenceAccumulation: AuditCheck = {
  id: "AUD-8",
  title: "influence accumulation",
  citations: citationsFor("AH-CFC-7", "AH-CFC-8"),
  falsifiedBy:
    "a confidentiality-labeled channel the model read that the run's model context holds no influence entry for, or an influence entry sourced from a channel the same result records as opaque or denied",
  inspect(run) {
    if (run.transcript.status !== "present") {
      return notReadable("transcript.json", run.transcript);
    }
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const influencing = new Set<string>();
    for (const observation of modelContextOf(run)?.observations ?? []) {
      for (const channel of observation.channels) {
        influencing.add(`${observation.toolCallId}:${channel}`);
      }
    }
    const evidence: CheckEvidence[] = [];
    let exposed = 0;
    for (const [index, message] of run.transcript.value.entries()) {
      if (message.role !== "tool") continue;
      for (const summary of channelSummaries(parsedToolContent(message))) {
        const key = `${message.toolCallId}:${summary.channel}`;
        if (summary.policy === "observed" && summary.labeled) {
          exposed += 1;
          if (!influencing.has(key)) {
            evidence.push({
              artifact: "transcript.json",
              pointer: `[${index}].cfc.${summary.channel}`,
              detail:
                `a labeled \`${summary.channel}\` the model read that the run's model context accumulates no influence for`,
            });
          }
          continue;
        }
        if (summary.policy !== "observed" && influencing.has(key)) {
          evidence.push({
            artifact: "run-state.json",
            pointer: "cfcModelContext.observations",
            detail:
              `influence accumulated from the \`${summary.channel}\` of ${message.toolCallId}, which the result records as \`${summary.policy}\``,
          });
        }
      }
    }
    if (evidence.length > 0) {
      return {
        verdict: "fail",
        message: `${
          count(
            evidence.length,
            "influence entry disagrees",
            "influence entries disagree",
          )
        } with what the transcript says the model was allowed to read`,
        evidence,
      };
    }
    if (exposed === 0 && influencing.size === 0) {
      return {
        verdict: "not-applicable",
        message:
          "this run exposed no labeled observation to the model and accumulated no influence",
      };
    }
    return {
      verdict: "pass",
      message: `the ${
        count(exposed, "labeled channel", "labeled channels")
      } the model read ${
        exposed === 1 ? "is" : "are"
      } accumulated as influence, and no denied or opaque channel is`,
    };
  },
};

//
// AUD-9 evidence retention
//

/** One artifact the claimed mode requires, and whether the run retained it. */
interface RetentionRequirement {
  name: string;
  held: boolean;
  detail: string;
}

const evidenceRetention: AuditCheck = {
  id: "AUD-9",
  title: "evidence retention",
  citations: citationsFor("AH-CFC-16", "AH-CFC-17"),
  falsifiedBy:
    "an enforcing run missing one of the artifacts that explain why a result was exposed or denied: its policy trace, its policy snapshot or that snapshot's digest, an invocation context for a side effect it executed, or any recorded attempt to read its space's cell labels",
  inspect(run) {
    if (run.runState.status !== "present") {
      return notReadable("run-state.json", run.runState);
    }
    const mode = runStateOf(run)!.cfcEnforcementMode;
    const digest = run.policyTrace.status === "present"
      ? run.policyTrace.value.cfcPolicySnapshotDigest
      : runStateOf(run)?.policyTrace?.cfcPolicySnapshotDigest;
    const contexts = invocationContextsOf(run);
    const effects = executedSideEffects(run);
    const requirements: readonly RetentionRequirement[] = [
      {
        name: "policy-trace.json",
        held: run.policyTrace.status === "present",
        detail: run.policyTrace.status,
      },
      {
        name: "policy-snapshot.json",
        held: run.policySnapshot.status === "present",
        detail: run.policySnapshot.status,
      },
      {
        name: "the policy snapshot's digest",
        held: typeof digest === "string" && digest.length > 0,
        detail: digest === undefined ? "absent" : "present",
      },
      {
        name: "a CFC invocation context",
        held: contexts.length > 0 || effects.length === 0,
        detail: `${contexts.length} recorded beside ${
          count(effects.length, "executed side effect", "executed side effects")
        }`,
      },
      {
        name: "a recorded cell-labels read",
        held: run.cellLabels.status === "present" ||
          runStateOf(run)?.cellLabels !== undefined,
        detail: run.cellLabels.status,
      },
    ];
    const missing = requirements.filter((requirement) => !requirement.held);
    if (missing.length === 0) {
      return {
        verdict: "pass",
        message:
          "this run retained every artifact needed to explain why a result was exposed or denied",
      };
    }
    return {
      verdict: isEnforcing(mode) ? "fail" : "warn",
      message: `this run claims \`${mode}\` and retained none of: ${
        missing.map((requirement) => requirement.name).join("; ")
      }`,
      evidence: missing.map((requirement) => ({
        artifact: requirement.name,
        detail: requirement.detail,
      })),
    };
  },
};

//
// The registry
//

/** Every Group A check, in id order. */
export const STRUCTURAL_CHECKS: readonly AuditCheck[] = [
  postureConsistency,
  modeBehaviorAttestation,
  decisionCoverage,
  denialChannel,
  handleDiscipline,
  transcriptPairing,
  observeDisclosure,
  influenceAccumulation,
  evidenceRetention,
];

/**
 * Runs every check over every run of `family`.
 *
 * A check that throws is a defect in the checker rather than a finding about
 * the run, so it reports `inconclusive` naming the failure: one unhandled
 * shape in one historic tree must not cost the verdicts on every tree after
 * it.
 */
export const auditRunFamily = (
  family: RunFamily,
  checks: readonly AuditCheck[] = STRUCTURAL_CHECKS,
): readonly CheckResult[] => {
  const results: CheckResult[] = [];
  for (const run of familyRuns(family)) {
    for (const check of checks) {
      let outcome: CheckOutcome;
      try {
        outcome = check.inspect(run, family);
      } catch (error) {
        outcome = {
          verdict: "inconclusive",
          message: `the check itself failed on this run: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      results.push({
        checkId: check.id,
        title: check.title,
        runId: run.runId,
        runDir: run.runDir,
        verdict: outcome.verdict,
        message: outcome.message,
        citations: check.citations,
        evidence: outcome.evidence ?? [],
      });
    }
  }
  return results;
};

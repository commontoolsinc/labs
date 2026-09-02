/**
 * The one posture record: what a runtime is actually enforcing, in a shape
 * every surface that publishes it publishes identically.
 *
 * A deployment whose enforcement dials cannot be read off it is
 * indistinguishable from a default one, so an operator has no way to confirm
 * what a runtime enforces (CT-2075's posture-visibility finding, AH-CFC-14).
 * Three surfaces answered that question in three shapes — a toolshed route, a
 * console startup line, a run-state section — and three shapes are three
 * things to keep in agreement. This is the one shape, derived from the
 * constructed Runtime's RESOLVED fields: a second reading of configuration
 * could disagree with the first, and the disagreement would be invisible.
 *
 * Two things the record insists on that a bare dial dump does not. An
 * `observe` rung carries what it decides on, so `policyEvaluation: observe`
 * cannot be read as active enforcement — it is a diagnostic that decides on
 * the un-rewritten label. And every known sink appears, whether or not a
 * ceiling governs it: a list of the governed sinks reads as coverage, and a
 * sink missing from it is exactly the gap a reader needed to see.
 */

import type { CfcConfClause } from "./clause.ts";
import type { PolicySnapshot } from "./policy.ts";
import {
  KNOWN_SINKS,
  type KnownSinkName,
  SINK_UNGATED_RATIONALES,
  type SinkMaxConfidentiality,
} from "./sink-inventory.ts";
import type {
  CfcDeclaredMonotonicityMode,
  CfcDecomposedEnvelopes,
  CfcEnforcementMode,
  CfcFlowLabelsMode,
  CfcLabelMetadataProtectionMode,
  CfcPolicyEvaluationMode,
  CfcTriggerReadGating,
  CfcWriteFloorMode,
} from "./types.ts";

/**
 * One dial's resolved rung, with what that rung decides on.
 *
 * `diagnosticOnly` is the field an operator reads first. Every ladder here
 * has a rung whose name contains a verb — `observe` — that records findings
 * and changes no outcome, and a posture printed as a bare value invites
 * reading that rung as enforcement. Stating it as a flag beside the words
 * means a reader does not have to know which ladder rung means what.
 */
export interface CfcDialReport {
  /** The dial's resolved value. */
  readonly rung: string;

  /** Whether this rung records findings without changing any outcome. */
  readonly diagnosticOnly: boolean;

  /** What this rung decides on, in one phrase. */
  readonly decidesOn: string;
}

/** How the deployment governs one sink's confidentiality release. */
export type CfcSinkReport =
  | {
    readonly sink: string;
    /** The confidentiality clauses a request may carry; empty is public-only. */
    readonly ceiling: readonly CfcConfClause[];
  }
  | {
    readonly sink: string;
    /** Why this sink releases with no ceiling, and therefore no gate. */
    readonly ungated: string;
  };

/**
 * A published departure from the posture the deployment otherwise holds:
 * what is not enforced, who carries it, and what would retire it (AH-CFC-15,
 * which asks that a deviation be published rather than silently taken).
 */
export interface CfcPostureDeviation {
  readonly what: string;
  readonly owner: string;
  readonly retirement: string;
}

/** What a runtime is enforcing, as one record. */
export interface CfcPostureReport {
  readonly enforcementMode: CfcDialReport;
  readonly flowLabels: CfcDialReport;
  readonly writeFloor: CfcDialReport;
  readonly triggerReadGating: boolean;
  readonly decomposedEnvelopes: boolean;
  readonly policyEvaluation: CfcDialReport;
  readonly labelMetadataProtection: CfcDialReport;
  readonly declaredMonotonicity: CfcDialReport;

  /** Digest of the deployment's policy snapshot; `null` when none is configured. */
  readonly policyDigest: string | null;

  /** Every known sink, in registry order, each governed or explicitly not. */
  readonly sinks: readonly CfcSinkReport[];

  /** Every published deviation from what this posture otherwise enforces. */
  readonly deviations: readonly CfcPostureDeviation[];
}

/**
 * The resolved CFC fields a posture record is read from. A `Runtime`
 * satisfies it; so does any other holder of the same resolved values, which
 * is what lets a host project the posture a runtime it has not built yet
 * will run at.
 */
export interface CfcPostureSource {
  readonly cfcEnforcementMode: CfcEnforcementMode;
  readonly cfcFlowLabels: CfcFlowLabelsMode;
  readonly cfcWriteFloor: CfcWriteFloorMode;
  readonly cfcTriggerReadGating: CfcTriggerReadGating;
  readonly cfcDecomposedEnvelopes: CfcDecomposedEnvelopes;
  readonly cfcPolicyEvaluation: CfcPolicyEvaluationMode;
  readonly cfcLabelMetadataProtection: CfcLabelMetadataProtectionMode;
  readonly cfcDeclaredMonotonicity: CfcDeclaredMonotonicityMode;
  readonly cfcPolicySnapshot: PolicySnapshot | undefined;
  readonly cfcSinkMaxConfidentiality: SinkMaxConfidentiality;
}

const ENFORCEMENT_MODE_DECIDES: Record<CfcEnforcementMode, string> = {
  disabled: "nothing; the boundary pass runs no gate and no reason rejects",
  observe: "nothing; a recorded reason is a diagnostic and the commit proceeds",
  "enforce-explicit": "a recorded reason, which rejects the commit",
  "enforce-strict":
    "a recorded reason, which rejects the commit, plus the strict-only fail-closed rejects",
};

const FLOW_LABELS_DECIDES: Record<CfcFlowLabelsMode, string> = {
  off: "nothing; no derived label component comes into existence",
  observe:
    "nothing; the per-tx flow join is derived and diagnosed but not written",
  persist:
    "the written derived label components, which the enforcing checks consume",
};

const WRITE_FLOOR_DECIDES: Record<CfcWriteFloorMode, string> = {
  off: "nothing; the write-side integrity floor is not checked",
  observe: "nothing; a floor miss is a diagnostic and the write proceeds",
  enforce: "the written value's integrity against the required floor",
};

const POLICY_EVALUATION_DECIDES: Record<CfcPolicyEvaluationMode, string> = {
  off: "nothing; gated labels reach the gates un-rewritten",
  observe:
    "the un-rewritten label; the rewrite is diagnosed, never applied to a decision",
  enforce:
    "the rewritten label, failing closed on fuel exhaustion or policy-lookup failure",
};

const LABEL_METADATA_DECIDES: Record<CfcLabelMetadataProtectionMode, string> = {
  off: "nothing; label metadata writes are not gated",
  observe: "nothing; an unauthorized label-metadata write is a diagnostic",
  enforce: "authority over the label metadata a write changes",
};

const DECLARED_MONOTONICITY_DECIDES: Record<
  CfcDeclaredMonotonicityMode,
  string
> = {
  off: "nothing; a declared-monotonicity violation is not checked",
  observe: "nothing; a monotonicity violation is a diagnostic",
  enforce: "the declared monotonicity of the written value",
};

/** A rung whose findings change no outcome. */
const DIAGNOSTIC_RUNGS: readonly string[] = ["off", "observe", "disabled"];

const dial = (
  rung: string,
  decidesOn: string,
): CfcDialReport => ({
  rung,
  diagnosticOnly: DIAGNOSTIC_RUNGS.includes(rung),
  decidesOn,
});

/**
 * Every known sink and how this runtime governs it.
 *
 * A sink with no ceiling gets no gate, so its entry says so in words rather
 * than by being absent. Where the sink is one the inventory records a
 * rationale for, those are the words; where it is not, the deployment simply
 * has not configured one, and the entry says that instead of inventing a
 * justification for it.
 */
const sinkReports = (
  ceilings: SinkMaxConfidentiality,
): readonly CfcSinkReport[] =>
  KNOWN_SINKS.map((sink: KnownSinkName): CfcSinkReport => {
    const ceiling = ceilings[sink];
    if (ceiling !== undefined) {
      return { sink, ceiling: [...ceiling] };
    }
    const rationale = SINK_UNGATED_RATIONALES[sink];
    return {
      sink,
      ungated: rationale?.reason ??
        "no confidentiality ceiling is configured for this sink",
    };
  });

/**
 * The deviations this runtime is running under: a sink the inventory records
 * a deliberate rationale for, which this runtime does indeed leave ungated.
 * A sink left ungated with no recorded rationale is not a deviation — it is a
 * deployment that has not configured a ceiling, which the audit weighs
 * against whatever posture the surface claims rather than against this list.
 */
const postureDeviations = (
  ceilings: SinkMaxConfidentiality,
): readonly CfcPostureDeviation[] =>
  KNOWN_SINKS.flatMap((sink: KnownSinkName): CfcPostureDeviation[] => {
    const rationale = SINK_UNGATED_RATIONALES[sink];
    if (rationale === undefined || ceilings[sink] !== undefined) {
      return [];
    }
    return [{
      what:
        `sink \`${sink}\` releases with no confidentiality ceiling, so no policy evaluation runs for it: ${rationale.reason}`,
      owner: rationale.owner,
      retirement: rationale.retirement,
    }];
  });

/** The CFC dial options a runtime construction may carry, all optional. */
export type CfcDialOptions = {
  readonly [K in keyof ResolvedCfcDials]?: ResolvedCfcDials[K];
};

/** Every CFC dial, resolved. */
export interface ResolvedCfcDials {
  readonly cfcEnforcementMode: CfcEnforcementMode;
  readonly cfcFlowLabels: CfcFlowLabelsMode;
  readonly cfcWriteFloor: CfcWriteFloorMode;
  readonly cfcTriggerReadGating: CfcTriggerReadGating;
  readonly cfcDecomposedEnvelopes: CfcDecomposedEnvelopes;
  readonly cfcPolicyEvaluation: CfcPolicyEvaluationMode;
  readonly cfcLabelMetadataProtection: CfcLabelMetadataProtectionMode;
  readonly cfcDeclaredMonotonicity: CfcDeclaredMonotonicityMode;
}

/**
 * The dial values a runtime constructed with `options` runs at.
 *
 * The `Runtime` constructor resolves its own fields through this, so a host
 * that has not built its runtime yet — a console printing its posture at
 * startup, a harness recording the posture a lazily-built session will run
 * at — projects the same values rather than restating the default table in
 * its own words. One table: a default moved here moves everywhere at once,
 * and a host cannot fall behind it silently.
 */
/**
 * What each dial resolves to when a construction leaves it unset.
 *
 * The Runtime's defaults, in one place, rather than eight `??` arms inside a
 * constructor no other host can reach. `DEFAULT_CFC_*` in `types.ts` are not
 * these: those are the per-transaction floors an unconfigured transaction
 * carries, which is a different question with a different answer.
 */
export const RUNTIME_CFC_DIAL_DEFAULTS: ResolvedCfcDials = Object.freeze({
  cfcEnforcementMode: "enforce-explicit",
  cfcFlowLabels: "off",
  cfcWriteFloor: "off",
  cfcTriggerReadGating: false,
  cfcDecomposedEnvelopes: false,
  cfcPolicyEvaluation: "off",
  cfcLabelMetadataProtection: "off",
  cfcDeclaredMonotonicity: "off",
});

/**
 * The dial values a runtime constructed with `options` runs at.
 *
 * The `Runtime` constructor resolves its own fields through this, so a host
 * that has not built its runtime yet — a console printing its posture at
 * startup, a harness recording the posture a lazily-built session will run
 * at — projects the same values rather than restating the default table in
 * its own words. One table: a default moved here moves everywhere at once,
 * and a host cannot fall behind it silently.
 */
export const resolveCfcDials = (
  options: CfcDialOptions,
): ResolvedCfcDials => ({
  cfcEnforcementMode: options.cfcEnforcementMode ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcEnforcementMode,
  cfcFlowLabels: options.cfcFlowLabels ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcFlowLabels,
  cfcWriteFloor: options.cfcWriteFloor ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcWriteFloor,
  cfcTriggerReadGating: options.cfcTriggerReadGating ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcTriggerReadGating,
  cfcDecomposedEnvelopes: options.cfcDecomposedEnvelopes ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcDecomposedEnvelopes,
  cfcPolicyEvaluation: options.cfcPolicyEvaluation ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcPolicyEvaluation,
  cfcLabelMetadataProtection: options.cfcLabelMetadataProtection ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcLabelMetadataProtection,
  cfcDeclaredMonotonicity: options.cfcDeclaredMonotonicity ??
    RUNTIME_CFC_DIAL_DEFAULTS.cfcDeclaredMonotonicity,
});

/** The posture record for a constructed runtime's resolved CFC fields. */
export const cfcPostureReport = (
  source: CfcPostureSource,
): CfcPostureReport => ({
  enforcementMode: dial(
    source.cfcEnforcementMode,
    ENFORCEMENT_MODE_DECIDES[source.cfcEnforcementMode],
  ),
  flowLabels: dial(
    source.cfcFlowLabels,
    FLOW_LABELS_DECIDES[source.cfcFlowLabels],
  ),
  writeFloor: dial(
    source.cfcWriteFloor,
    WRITE_FLOOR_DECIDES[source.cfcWriteFloor],
  ),
  triggerReadGating: source.cfcTriggerReadGating === true,
  decomposedEnvelopes: source.cfcDecomposedEnvelopes === true,
  policyEvaluation: dial(
    source.cfcPolicyEvaluation,
    POLICY_EVALUATION_DECIDES[source.cfcPolicyEvaluation],
  ),
  labelMetadataProtection: dial(
    source.cfcLabelMetadataProtection,
    LABEL_METADATA_DECIDES[source.cfcLabelMetadataProtection],
  ),
  declaredMonotonicity: dial(
    source.cfcDeclaredMonotonicity,
    DECLARED_MONOTONICITY_DECIDES[source.cfcDeclaredMonotonicity],
  ),
  policyDigest: source.cfcPolicySnapshot?.digest ?? null,
  sinks: sinkReports(source.cfcSinkMaxConfidentiality),
  deviations: postureDeviations(source.cfcSinkMaxConfidentiality),
});

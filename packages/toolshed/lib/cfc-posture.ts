/**
 * The CFC posture this server runs at, published on `/api/meta` beside the
 * experimental-flag posture (`experimental-posture.ts`, whose module-state
 * rationale this mirrors): a deployment whose enforcement dials cannot be
 * read off it is indistinguishable from a default one, so an operator has no
 * way to confirm what a runtime is actually enforcing (CT-2075's posture
 * visibility finding). Reporting only — the values come from the constructed
 * Runtime's resolved fields, never from a second reading of configuration
 * that could disagree with the first.
 *
 * The base webhook Runtime is the one reported. The per-space serving
 * runtimes the executor host builds hand-roll their options deliberately and
 * carry the same CFC dials from the same code path, so a separate override
 * channel would report nothing the base does not.
 */

import type { Runtime } from "@commonfabric/runner";

/** What `/api/meta` reports about the deployment's CFC dials. */
export interface CfcPostureReport {
  readonly enforcementMode: string;
  readonly flowLabels: string;
  readonly writeFloor: string;
  readonly triggerReadGating: boolean;
  readonly decomposedEnvelopes: boolean;
  readonly policyEvaluation: string;
  readonly labelMetadataProtection: string;
  readonly declaredMonotonicity: string;
  /** Digest of the deployment policy snapshot; `null` when none configured. */
  readonly policyDigest: string | null;
  /** Sink names with a declared confidentiality ceiling, sorted. */
  readonly sinkCeilings: string[];
}

type CfcPostureSource = Pick<
  Runtime,
  | "cfcEnforcementMode"
  | "cfcFlowLabels"
  | "cfcWriteFloor"
  | "cfcTriggerReadGating"
  | "cfcDecomposedEnvelopes"
  | "cfcPolicyEvaluation"
  | "cfcLabelMetadataProtection"
  | "cfcDeclaredMonotonicity"
  | "cfcPolicySnapshot"
  | "cfcSinkMaxConfidentiality"
>;

let posture: CfcPostureReport | null = null;

/**
 * Record a constructed Runtime's resolved CFC dials. Pass `null` to publish
 * nothing, which is also the state before any Runtime exists — a client then
 * reads `cfc: null` as "this deployment said nothing".
 */
export function publishCfcPosture(runtime: CfcPostureSource | null): void {
  if (runtime === null) {
    posture = null;
    return;
  }
  posture = {
    enforcementMode: runtime.cfcEnforcementMode,
    flowLabels: runtime.cfcFlowLabels,
    writeFloor: runtime.cfcWriteFloor,
    triggerReadGating: runtime.cfcTriggerReadGating === true,
    decomposedEnvelopes: runtime.cfcDecomposedEnvelopes === true,
    policyEvaluation: runtime.cfcPolicyEvaluation,
    labelMetadataProtection: runtime.cfcLabelMetadataProtection,
    declaredMonotonicity: runtime.cfcDeclaredMonotonicity,
    policyDigest: runtime.cfcPolicySnapshot?.digest ?? null,
    sinkCeilings: Object.keys(runtime.cfcSinkMaxConfidentiality).sort(),
  };
}

/** What `/api/meta` reports; `null` until a Runtime has been constructed. */
export function cfcPosture(): CfcPostureReport | null {
  return posture;
}

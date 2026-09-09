/**
 * What a run family's sandbox work is known to have been exposed to, and
 * whether that knowledge is complete.
 *
 * `ingest_sandbox_file` mints a cell's label from this and nothing else, so
 * two things have to hold at once: every sandbox invocation the family ran
 * must have contributed, and any invocation that ran without leaving trusted
 * evidence must be visible as a hole rather than as an absence of taint. The
 * second is why this is a state rather than a label. An invocation whose
 * result carries no readable container taint could have written anything under
 * any label, so the family's knowledge is not "clean" — it is gone, and it
 * does not come back within the run. There is no recovery, because nothing
 * later can establish what that invocation did.
 *
 * Held per run FAMILY, keyed by the root run's id, because a delegated child
 * shares its parent's workspace and sandbox: a child's taint has to reach its
 * parent's ingest and the parent's has to reach the child's.
 *
 * Module-private, and reachable only through these functions. The state is
 * trusted evidence about untrusted work, so nothing that a tool input or a
 * sandboxed workload can reach may set it.
 */

import type { IFCLabel } from "@commonfabric/runner/cfc";
import { mergeConfidentialityOnlyLabels } from "./contracts/cfc-model-context.ts";

export type HarnessWorkspaceTaint =
  | {
    /** Every sandbox invocation so far reported a container taint. */
    readonly kind: "known";
    /** The join of those taints; absent when every one of them was public. */
    readonly label?: IFCLabel;
  }
  | {
    /** An invocation ran whose taint could not be established. */
    readonly kind: "unknown";
    readonly reason: string;
  };

const taints = new Map<string, HarnessWorkspaceTaint>();

/** What is known about `familyRunId`'s sandbox work. */
export const workspaceTaint = (
  familyRunId: string,
): HarnessWorkspaceTaint => taints.get(familyRunId) ?? { kind: "known" };

/**
 * Joins one invocation's container taint into the family's.
 *
 * Monotone in both directions it can move: confidentiality only accumulates,
 * and a family already `unknown` stays `unknown`, so an evidence-less
 * invocation cannot be washed out by a later clean one.
 */
export const joinWorkspaceTaint = (
  familyRunId: string,
  label: IFCLabel,
): HarnessWorkspaceTaint => {
  const current = workspaceTaint(familyRunId);
  if (current.kind === "unknown") {
    return current;
  }
  const merged = mergeConfidentialityOnlyLabels([current.label, label]);
  const next: HarnessWorkspaceTaint = merged === undefined
    ? { kind: "known" }
    : { kind: "known", label: merged };
  taints.set(familyRunId, next);
  return next;
};

/**
 * Records that an invocation ran whose taint could not be established, naming
 * what was missing. First reason wins: it names the invocation that lost the
 * evidence, and a later one describes a family that was already unknown.
 */
export const poisonWorkspaceTaint = (
  familyRunId: string,
  reason: string,
): HarnessWorkspaceTaint => {
  const current = workspaceTaint(familyRunId);
  if (current.kind === "unknown") {
    return current;
  }
  const next: HarnessWorkspaceTaint = { kind: "unknown", reason };
  taints.set(familyRunId, next);
  return next;
};

/**
 * Seeds a family's state from a run's persisted record, on resume.
 *
 * The in-process map is empty when a resumed run starts, and an empty entry
 * reads as known-clean — so a run that ended `unknown` would come back able
 * to mint. Seeding is monotone in the same two directions the live joins are:
 * a persisted `unknown` poisons, and a persisted label joins.
 *
 * A resumed run whose record says NOTHING about its taint gets `unknown`
 * rather than clean. Its earlier invocations are not in this process's map,
 * and a run state written before this field existed cannot say whether they
 * were clean; that is the same absence of evidence a lost sidecar leaves.
 */
export const seedWorkspaceTaintFromRunState = (
  familyRunId: string,
  persisted: HarnessWorkspaceTaint | undefined,
): HarnessWorkspaceTaint => {
  if (persisted === undefined) {
    return poisonWorkspaceTaint(
      familyRunId,
      "this run was resumed from a record that says nothing about what its " +
        "earlier sandbox invocations were exposed to",
    );
  }
  if (persisted.kind === "unknown") {
    return poisonWorkspaceTaint(familyRunId, persisted.reason);
  }
  return persisted.label === undefined
    ? workspaceTaint(familyRunId)
    : joinWorkspaceTaint(familyRunId, persisted.label);
};

/**
 * Drops a family's accumulated taint. For tests, which run many families in
 * one process; a run never forgets what its sandbox was exposed to.
 */
export const forgetWorkspaceTaintForTesting = (familyRunId: string): void => {
  taints.delete(familyRunId);
};

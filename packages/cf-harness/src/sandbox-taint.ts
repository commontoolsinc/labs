/**
 * What a run's sandbox work is known to have been exposed to, and whether
 * that knowledge is complete.
 *
 * OBSERVABILITY, NOT AUTHORITY. Nothing in this package consumes this as a
 * source of labels: no value is minted from it and no decision turns on it.
 * It is what a reader of a run learns about the containers that run started —
 * which requirements their work carried, and whether the harness can still
 * account for all of them. Kept honest to that standard rather than a weaker
 * one because the moment something DOES read it as authority, the difference
 * between "nothing was carried" and "we cannot say" becomes the difference
 * between a correct label and a silently wrong one, and a record built on the
 * weaker standard would already be wrong by then.
 *
 * That is why this is a state rather than a label. An invocation whose result
 * carries no readable container taint could have done anything, so the run's
 * knowledge is not "clean" — it is gone, and it does not come back within the
 * run. There is no recovery, because nothing later can establish what that
 * invocation did.
 *
 * Module-private, and reachable only through these functions. The state is
 * trusted evidence about untrusted work, so nothing a tool input or a
 * sandboxed workload can reach may set it.
 */

import type { IFCLabel } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { mergeConfidentialityOnlyLabels } from "./contracts/cfc-model-context.ts";
import { inertLabelSnapshot } from "./ifc-label-shape.ts";

export type HarnessSandboxTaint =
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

/**
 * Whether a taint is a shape this can carry, checked before anything reads
 * one that came from outside this process.
 *
 * The run's record is a file. Whatever wrote it last — an earlier run, a
 * hand, a partial write this could not detect — is not this process, so its
 * contents are data rather than state. A `kind` outside the two defined, or a
 * label with a shape the merge would refuse or a serializer would raise on,
 * is not a run that saw nothing; it is a record this cannot read.
 */
const isRepresentableTaint = (
  value: unknown,
): value is HarnessSandboxTaint => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  if (value.kind === "unknown") {
    return typeof value.reason === "string";
  }
  if (value.kind !== "known") {
    return false;
  }
  return value.label === undefined ||
    inertLabelSnapshot(value.label) !== undefined;
};

const taints = new Map<string, HarnessSandboxTaint>();

/** What is known about `runId`'s sandbox work. */
export const sandboxTaint = (
  runId: string,
): HarnessSandboxTaint => taints.get(runId) ?? { kind: "known" };

/**
 * Joins one invocation's container taint into the run's.
 *
 * Monotone in both directions it can move: confidentiality only accumulates,
 * and a run already `unknown` stays `unknown`, so an evidence-less
 * invocation cannot be washed out by a later clean one.
 */
export const joinSandboxTaint = (
  runId: string,
  label: IFCLabel,
): HarnessSandboxTaint => {
  const current = sandboxTaint(runId);
  if (current.kind === "unknown") {
    return current;
  }
  // A label the merge would refuse, or that would raise on the way through
  // it, is not evidence of a public container. Callers validate before they
  // get here; this makes the function total for the ones that do not.
  if (inertLabelSnapshot(label) === undefined) {
    return poisonSandboxTaint(
      runId,
      "a sandbox invocation reported a taint whose shape cannot be read",
    );
  }
  const merged = mergeConfidentialityOnlyLabels([current.label, label]);
  const next: HarnessSandboxTaint = merged === undefined
    ? { kind: "known" }
    : { kind: "known", label: merged };
  taints.set(runId, next);
  return next;
};

/**
 * Records that an invocation ran whose taint could not be established, naming
 * what was missing. First reason wins: it names the invocation that lost the
 * evidence, and a later one describes a run that was already unknown.
 */
export const poisonSandboxTaint = (
  runId: string,
  reason: string,
): HarnessSandboxTaint => {
  const current = sandboxTaint(runId);
  if (current.kind === "unknown") {
    return current;
  }
  const next: HarnessSandboxTaint = { kind: "unknown", reason };
  taints.set(runId, next);
  return next;
};

/**
 * Seeds a run's state from a run's persisted record, on resume.
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
export const seedSandboxTaint = (
  runId: string,
  persisted: HarnessSandboxTaint | undefined,
): HarnessSandboxTaint => {
  if (persisted === undefined) {
    return poisonSandboxTaint(
      runId,
      "this run was resumed from a record that says nothing about what its " +
        "earlier sandbox invocations were exposed to",
    );
  }
  if (!isRepresentableTaint(persisted)) {
    return poisonSandboxTaint(
      runId,
      "the record this run's run state was read from does not describe a " +
        "state this build can read, so what its earlier invocations were " +
        "exposed to cannot be established",
    );
  }
  if (persisted.kind === "unknown") {
    return poisonSandboxTaint(runId, persisted.reason);
  }
  return persisted.label === undefined
    ? sandboxTaint(runId)
    : joinSandboxTaint(runId, persisted.label);
};

/**
 * Drops a run's accumulated taint. For tests, which run many families in
 * one process; a run never forgets what its sandbox was exposed to.
 */
export const forgetSandboxTaintForTesting = (runId: string): void => {
  taints.delete(runId);
};

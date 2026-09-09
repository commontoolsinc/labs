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
 * A taint read out of something that came from outside this process, as inert
 * data, or `undefined` when it is not a shape this can carry.
 *
 * The run's record is a file. Whatever wrote it last — an earlier run, a
 * hand, a partial write this could not detect — is not this process, so its
 * contents are data rather than state. A `kind` outside the two defined, or a
 * label with a shape the merge would refuse or a serializer would raise on,
 * is not a run that saw nothing; it is a record this cannot read.
 *
 * A COPY rather than a verdict about the source, because a verdict is only
 * true of the read that produced it. Everything downstream — the poison
 * reason, the join, the seeded state — is built from what this returned, and
 * the value it was read from is never consulted again.
 */
const readTaint = (value: unknown): HarnessSandboxTaint | undefined => {
  try {
    return readTaintRecord(value);
  } catch {
    // The record is data from outside this process, and the seam it arrives
    // through carries objects as well as parsed JSON — an accessor on it can
    // raise. Seeding runs inside engine construction, where an exception does
    // not read as a lost run: it takes the run down, and a caller that
    // catches it is left with a state that still reads as clean.
    return undefined;
  }
};

/**
 * Each field taken exactly once, and every later step built from the locals.
 *
 * The label is the one that matters most, but `kind` decides which record
 * this is at all, so a second read of either is a second chance for the
 * source to say something no check saw.
 */
const readTaintRecord = (value: unknown): HarnessSandboxTaint | undefined => {
  if (!isObjectNotArray(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind === "unknown") {
    const reason = value.reason;
    return typeof reason === "string" ? { kind: "unknown", reason } : undefined;
  }
  if (kind !== "known") {
    return undefined;
  }
  const label = value.label;
  if (label === undefined) {
    return { kind: "known" };
  }
  const snapshot = inertLabelSnapshot(label);
  return snapshot === undefined
    ? undefined
    : { kind: "known", label: snapshot as IFCLabel };
};

/**
 * The state as something no later hand can change, stored and handed out.
 *
 * This is trusted evidence about untrusted work, and the map holding it is
 * module-private for that reason. Handing a caller the stored object would
 * put the accumulator back within reach of anything holding a reference to
 * what it read — a clause pushed onto a returned label is a run recorded as
 * carrying something no invocation reported. The structure is a small inert
 * record, so freezing all of it costs nothing worth counting.
 */
const frozenTaint = (taint: HarnessSandboxTaint): HarnessSandboxTaint => {
  if (taint.kind === "known" && taint.label !== undefined) {
    for (const clause of Object.values(taint.label)) {
      if (Array.isArray(clause)) {
        deepFreeze(clause);
      }
    }
    Object.freeze(taint.label);
  }
  return Object.freeze(taint);
};

const deepFreeze = (value: unknown): void => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
};

const taints = new Map<string, HarnessSandboxTaint>();

/** What is known about `runId`'s sandbox work. */
export const sandboxTaint = (
  runId: string,
): HarnessSandboxTaint => taints.get(runId) ?? frozenTaint({ kind: "known" });

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
  // Snapshotted once, and the SNAPSHOT is what merges. Passing the original
  // on would read it a second time, and a source that answered differently
  // then would put something in the record that no check ever saw. A label
  // the merge would refuse, or that would raise on the way through it, is not
  // evidence of a public container either.
  const snapshot = inertLabelSnapshot(label);
  if (snapshot === undefined) {
    return poisonSandboxTaint(
      runId,
      "a sandbox invocation reported a taint whose shape cannot be read",
    );
  }
  const merged = mergeConfidentialityOnlyLabels([
    current.label,
    snapshot as IFCLabel,
  ]);
  const next = frozenTaint(
    merged === undefined ? { kind: "known" } : { kind: "known", label: merged },
  );
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
  const next = frozenTaint({ kind: "unknown", reason });
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
  const read = readTaint(persisted);
  if (read === undefined) {
    return poisonSandboxTaint(
      runId,
      "the record this run's state was read from does not describe a state " +
        "this build can read, so what its earlier invocations were exposed " +
        "to cannot be established",
    );
  }
  if (read.kind === "unknown") {
    return poisonSandboxTaint(runId, read.reason);
  }
  // The snapshot `readTaint` took, not the record it came from.
  return read.label === undefined
    ? sandboxTaint(runId)
    : joinSandboxTaint(runId, read.label);
};

/**
 * Drops a run's accumulated taint. For tests, which run many families in
 * one process; a run never forgets what its sandbox was exposed to.
 */
export const forgetSandboxTaintForTesting = (runId: string): void => {
  taints.delete(runId);
};

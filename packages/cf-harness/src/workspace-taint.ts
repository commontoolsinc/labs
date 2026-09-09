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
import { isObjectNotArray } from "@commonfabric/utils/types";
import { mergeConfidentialityOnlyLabels } from "./contracts/cfc-model-context.ts";
import { isRepresentableIfcLabel } from "./ifc-label-shape.ts";

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

/**
 * Whether a taint is a shape this can carry, checked before anything reads
 * one that came from outside this process.
 *
 * The family's record is a file. Whatever wrote it last — an earlier run, a
 * hand, a partial write this could not detect — is not this process, so its
 * contents are data rather than state. A `kind` outside the two defined, or a
 * label with a shape the merge would refuse or a serializer would raise on,
 * is not a family that saw nothing; it is a record this cannot read.
 */
const isRepresentableTaint = (
  value: unknown,
): value is HarnessWorkspaceTaint => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  if (value.kind === "unknown") {
    return typeof value.reason === "string";
  }
  if (value.kind !== "known") {
    return false;
  }
  return value.label === undefined || isRepresentableIfcLabel(value.label);
};

const taints = new Map<string, HarnessWorkspaceTaint>();

/** Where a family's record is kept, once one has been established. */
const recordPaths = new Map<string, string>();

const encoder = new TextEncoder();

/**
 * Writes the family's state where every engine in the family can read it,
 * replacing the file in one step.
 *
 * A run record cannot carry this on its own. The engine that learns something
 * is whichever one ran the container, and it writes only ITS record; a child
 * that saw a label leaves its parent's record — the one a later resume reads
 * — saying the family was clean. Worse, the parent may never persist again.
 * One file per family, rewritten on every join, is what makes the answer
 * independent of which engine wrote last, or at all.
 *
 * Written to a neighbouring name and renamed over, so a reader never sees a
 * half-written file: a truncated record would parse as absent, and absent is
 * the one answer that must never be reached by accident.
 */
const persistRecord = (familyRunId: string): void => {
  const path = recordPaths.get(familyRunId);
  if (path === undefined) {
    return;
  }
  const taint = taints.get(familyRunId);
  if (taint === undefined) {
    return;
  }
  const pending = `${path}.${crypto.randomUUID()}.pending`;
  try {
    Deno.writeFileSync(
      pending,
      encoder.encode(JSON.stringify({
        type: "cf-harness.family-taint",
        version: 1,
        familyRunId,
        taint,
      })),
    );
    Deno.renameSync(pending, path);
  } catch {
    // A family whose record cannot be written still holds its state in this
    // process. What is lost is the next process's ability to read it, and
    // that reader treats a record it cannot read as `unknown`.
    try {
      Deno.removeSync(pending);
    } catch {
      // Nothing to clean up.
    }
  }
};

/**
 * Names the file this family's state is kept in, and seeds the family from it
 * when one is already there.
 *
 * Called by every engine in the family, so the first one establishes the file
 * and the rest join it. Seeding is monotone in both directions the state can
 * move, so an engine arriving late cannot lower what an earlier one recorded.
 */
export const useWorkspaceTaintRecord = (
  familyRunId: string,
  path: string,
): { readonly found: boolean; readonly taint: HarnessWorkspaceTaint } => {
  recordPaths.set(familyRunId, path);
  let stored: unknown;
  try {
    stored = JSON.parse(Deno.readTextFileSync(path));
  } catch {
    stored = undefined;
  }
  if (stored === undefined) {
    // Nothing this family wrote that can be read at all — no file, or bytes
    // that are not JSON. There is nothing to seed FROM, which is a different
    // answer from a record that says something unreadable.
    persistRecord(familyRunId);
    return { found: false, taint: workspaceTaint(familyRunId) };
  }
  // The envelope before its contents: a file at this family's own path that
  // does not describe this family's state is one this cannot account for, and
  // a family it cannot account for has no label to mint.
  if (
    !isObjectNotArray(stored) ||
    stored.type !== "cf-harness.family-taint" || stored.version !== 1 ||
    typeof stored.familyRunId !== "string"
  ) {
    return {
      found: true,
      taint: poisonWorkspaceTaint(
        familyRunId,
        "the file holding this run family's state does not describe one, so " +
          "what its earlier invocations were exposed to cannot be established",
      ),
    };
  }
  // A record that exists and cannot be read is FOUND: it is this family's
  // record, and the seed below poisons on it. Reporting it as absent would
  // send the caller to its own run state, which describes a different thing.
  return {
    found: true,
    taint: seedWorkspaceTaint(
      familyRunId,
      stored.taint as HarnessWorkspaceTaint | undefined,
    ),
  };
};

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
  // A label the merge would refuse, or that would raise on the way through
  // it, is not evidence of a public container. Callers validate before they
  // get here; this makes the function total for the ones that do not.
  if (!isRepresentableIfcLabel(label)) {
    return poisonWorkspaceTaint(
      familyRunId,
      "a sandbox invocation reported a taint whose shape cannot be read",
    );
  }
  const merged = mergeConfidentialityOnlyLabels([current.label, label]);
  const next: HarnessWorkspaceTaint = merged === undefined
    ? { kind: "known" }
    : { kind: "known", label: merged };
  taints.set(familyRunId, next);
  persistRecord(familyRunId);
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
  persistRecord(familyRunId);
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
export const seedWorkspaceTaint = (
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
  if (!isRepresentableTaint(persisted)) {
    return poisonWorkspaceTaint(
      familyRunId,
      "the record this run's family state was read from does not describe a " +
        "state this build can read, so what its earlier invocations were " +
        "exposed to cannot be established",
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
  recordPaths.delete(familyRunId);
};

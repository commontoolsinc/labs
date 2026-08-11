// Naive reference model for commit admission and value application.
//
// This is the "obviously correct, unoptimized" half of the differential
// consistency harness (v2-differential-consistency.test.ts): no SQL, no
// tier shortcuts, no memoization — a direct transcription of the admission
// rules in docs/specs/memory-v2/03-commit-model.md §3.6 over an in-memory
// history of accepted commits.
//
// The refinement obligation it checks is one-directional (INV-2 in
// docs/specs/memory-v2/09-invariants.md): the engine MAY reject commits this
// model would accept (over-approximation costs a retry), but MUST NOT accept
// a commit this model rejects.
//
// Deliberate fidelity notes:
//   - Overlap is exact ancestor/descendant path prefixing; `set`/`delete`
//     overlap every read of the entity. The engine's matcher may only be
//     coarser than this, never finer.
//   - Pending-read staleness: a read declaring its true confirmed basis
//     (`basisSeq`, the CT-1910 repair) is scanned over the FULL interval
//     from that basis, excluding only the reader's own session's TRUE
//     PREDECESSOR commits (localSeq below the reader's — the layers its
//     view included; an own write accepted out of submission order
//     conflicts like a foreign one). A legacy read (no `basisSeq`) is
//     based at the HIGHEST dependency's resolution seq — the pre-repair
//     semantics whose over-advance is recorded against INV-1 in
//     09-invariants.md and kept here as the reference for legacy traffic.
//   - Scope and branch dimensions are not modeled; the generator stays on
//     the default branch and space scope.
//   - Inferred dependencies (CT-1910, the localSeq-less shape): the model
//     keeps every rejected commit's touched-doc set per session and dooms a
//     reader iff some rejected same-session commit L with
//     verdictsThrough < L < reader.localSeq touched the read's document.
//     Watermarks are per-session MONOTONIC: the effective watermark is the
//     max over every attested value (the engine prunes retention at that
//     max, so a later stale attestation cannot resurrect a retired entry).
//     Staleness for the inferred shape is the `basisSeq` scan above,
//     unchanged.

import type { ClientCommit, Operation, PatchOp } from "../v2.ts";

export interface NaiveOp {
  id: string;
  kind: "set" | "patch";
  /** Leaf value paths touched by a patch (unused for `set`). */
  leafPaths: string[][];
}

export interface NaiveCommit {
  seq: number;
  sessionId: string;
  localSeq: number;
  ops: NaiveOp[];
}

export interface NaiveHistory {
  accepted: NaiveCommit[];
  /** sessionId -> localSeq -> resolution seq (accepted commits only). */
  resolution: Map<string, Map<number, number>>;
  /** sessionId -> rejected commits' touched-doc sets, ascending localSeq
   * (the CT-1910 inference candidates). */
  rejected: Map<string, Array<{ localSeq: number; touchedIds: Set<string> }>>;
  /** sessionId -> highest attested verdict watermark (monotonic). */
  watermarks: Map<string, number>;
}

export const emptyHistory = (): NaiveHistory => ({
  accepted: [],
  resolution: new Map(),
  rejected: new Map(),
  watermarks: new Map(),
});

export type NaiveVerdict =
  | { accepted: true }
  | { accepted: false; reason: string };

const pointerToPath = (pointer: string): string[] =>
  pointer.replace(/^\//, "").split("/");

const isPrefix = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((seg, i) => seg === b[i]);

/** Exact bidirectional overlap: ancestor, descendant, or equal. */
export const naivePathsOverlap = (
  a: readonly string[],
  b: readonly string[],
): boolean => isPrefix(a, b) || isPrefix(b, a);

export const toNaiveOps = (operations: Operation[]): NaiveOp[] =>
  operations.map((op) => {
    if (op.op === "patch") {
      return {
        id: op.id,
        kind: "patch" as const,
        leafPaths: op.patches.map((p: PatchOp) => pointerToPath(p.path)),
      };
    }
    if (op.op === "set" || op.op === "delete") {
      // Both are path-blind: they overlap every read of the entity.
      return { id: op.id, kind: "set" as const, leafPaths: [] };
    }
    throw new Error(`naive model: unsupported operation kind ${op.op}`);
  });

const writeOverlapsRead = (
  op: NaiveOp,
  readPath: readonly string[],
): boolean =>
  op.kind === "set" ||
  op.leafPaths.some((leaf) => naivePathsOverlap(leaf, readPath));

const conflictSeq = (
  history: NaiveHistory,
  id: string,
  readPath: readonly string[],
  afterSeq: number,
  // CT-1910 true-basis scans exclude the reader's own session's TRUE
  // PREDECESSOR commits (localSeq below the reader's): those were part of
  // its materialized view. An own write with a higher localSeq accepted
  // first (out-of-order submission) conflicts like a foreign write.
  exclude?: { sessionId: string; beforeLocalSeq: number },
): number | null => {
  for (const commit of history.accepted) {
    if (commit.seq <= afterSeq) continue;
    if (
      exclude !== undefined && commit.sessionId === exclude.sessionId &&
      commit.localSeq < exclude.beforeLocalSeq
    ) {
      continue;
    }
    for (const op of commit.ops) {
      if (op.id === id && writeOverlapsRead(op, readPath)) return commit.seq;
    }
  }
  return null;
};

/**
 * The reference admission decision for `commit` from `sessionId`, given the
 * accepted history so far. Mirrors §3.6 exactly, without shortcuts.
 */
export const naiveAdmit = (
  history: NaiveHistory,
  sessionId: string,
  commit: ClientCommit,
): NaiveVerdict => {
  for (const read of commit.reads.confirmed) {
    const cs = conflictSeq(history, read.id, read.path, read.seq);
    if (cs !== null) {
      return {
        accepted: false,
        reason: `stale confirmed read: ${read.id}@${read.seq} vs seq ${cs}`,
      };
    }
  }
  const sessionRes = history.resolution.get(sessionId);
  for (const read of commit.reads.pending) {
    if (read.localSeq === undefined) {
      // Inferred shape (CT-1910): dependency soundness comes from the
      // rejected-commit rule; staleness from the declared true basis.
      if (read.basisSeq === undefined) {
        return {
          accepted: false,
          reason: `inferred read on ${read.id} names no basisSeq`,
        };
      }
      if (commit.verdictsThrough === undefined) {
        return {
          accepted: false,
          reason: `inferred read on ${read.id} without verdictsThrough`,
        };
      }
      const watermark = Math.max(
        commit.verdictsThrough,
        history.watermarks.get(sessionId) ?? 0,
      );
      for (const entry of history.rejected.get(sessionId) ?? []) {
        if (entry.localSeq >= commit.localSeq) break;
        if (entry.localSeq <= watermark) continue;
        if (entry.touchedIds.has(read.id)) {
          return {
            accepted: false,
            reason:
              `rejected pending dependency inferred: ${entry.localSeq} touched ${read.id}`,
          };
        }
      }
      const cs = conflictSeq(history, read.id, read.path, read.basisSeq, {
        sessionId,
        beforeLocalSeq: commit.localSeq,
      });
      if (cs !== null) {
        return {
          accepted: false,
          reason: `stale pending read: ${read.id} vs seq ${cs}`,
        };
      }
      continue;
    }
    const layers = Array.isArray(read.localSeq)
      ? read.localSeq
      : [read.localSeq];
    let basis: number | undefined;
    for (const localSeq of layers) {
      const seq = sessionRes?.get(localSeq);
      if (seq === undefined) {
        return {
          accepted: false,
          reason: `pending dependency not resolved: ${localSeq}`,
        };
      }
      if (basis === undefined || seq > basis) basis = seq;
    }
    const cs = read.basisSeq !== undefined
      ? conflictSeq(history, read.id, read.path, read.basisSeq, {
        sessionId,
        beforeLocalSeq: commit.localSeq,
      })
      : conflictSeq(history, read.id, read.path, basis!);
    if (cs !== null) {
      return {
        accepted: false,
        reason: `stale pending read: ${read.id} vs seq ${cs}`,
      };
    }
  }
  return { accepted: true };
};

/** Records an engine-accepted commit into the reference history. */
export const naiveRecord = (
  history: NaiveHistory,
  sessionId: string,
  commit: ClientCommit,
  seq: number,
): void => {
  history.accepted.push({
    seq,
    sessionId,
    localSeq: commit.localSeq,
    ops: toNaiveOps(commit.operations),
  });
  let sessionRes = history.resolution.get(sessionId);
  if (!sessionRes) {
    sessionRes = new Map();
    history.resolution.set(sessionId, sessionRes);
  }
  sessionRes.set(commit.localSeq, seq);
  noteAttestedWatermark(history, sessionId, commit);
};

/** Records an engine-rejected commit's touched-doc set — the CT-1910
 * inference candidates a later inferred-shape reader is judged against. */
export const naiveRecordRejected = (
  history: NaiveHistory,
  sessionId: string,
  commit: ClientCommit,
): void => {
  const touchedIds = new Set<string>();
  for (const op of commit.operations) {
    if (op.op !== "sqlite") touchedIds.add(op.id);
  }
  let entries = history.rejected.get(sessionId);
  if (!entries) {
    entries = [];
    history.rejected.set(sessionId, entries);
  }
  entries.push({ localSeq: commit.localSeq, touchedIds });
  entries.sort((a, b) => a.localSeq - b.localSeq);
  noteAttestedWatermark(history, sessionId, commit);
};

// A watermark counts from the commit that CARRIED it whatever its fate:
// the engine prunes retention at attestation time on accept and reject
// alike.
const noteAttestedWatermark = (
  history: NaiveHistory,
  sessionId: string,
  commit: ClientCommit,
): void => {
  if (commit.verdictsThrough === undefined) return;
  const current = history.watermarks.get(sessionId) ?? 0;
  if (commit.verdictsThrough > current) {
    history.watermarks.set(sessionId, commit.verdictsThrough);
  }
};

// --- Reference value semantics (INV-9's naive fold) ---------------------

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Applies accepted operations to the naive value store. Supports the op
 * shapes the differential generator emits: whole-document `set`, object-key
 * `replace`/`add`, and array append (`.../-`).
 */
export const naiveApply = (
  store: Map<string, Record<string, unknown>>,
  operations: Operation[],
): void => {
  for (const op of operations) {
    if (op.op === "set") {
      store.set(op.id, clone(op.value) as Record<string, unknown>);
      continue;
    }
    if (op.op !== "patch") {
      throw new Error(`naiveApply: unsupported op ${op.op}`);
    }
    const doc = store.get(op.id);
    if (!doc) throw new Error(`naiveApply: patch on missing entity ${op.id}`);
    for (const patch of op.patches) {
      if (patch.op !== "replace" && patch.op !== "add") {
        throw new Error(`naiveApply: unsupported patch op ${patch.op}`);
      }
      const path = pointerToPath(patch.path);
      let container: Record<string, unknown> = doc;
      for (const seg of path.slice(0, -1)) {
        container = container[seg] as Record<string, unknown>;
        if (container === undefined) {
          throw new Error(`naiveApply: missing container at ${patch.path}`);
        }
      }
      const last = path[path.length - 1];
      if (last === "-") {
        (container as unknown as unknown[]).push(clone(patch.value));
      } else {
        container[last] = clone(patch.value);
      }
    }
  }
};

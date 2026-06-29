// State-at-(branch, seq) reconstruction by replaying the append-only revision log.
//
// A memory v2 entity document has the shape `{ value: <FabricValue>, source?: … }`.
// Each `revision` row is one operation on that document:
//   - op="set"    → data is the whole replacement document
//   - op="patch"  → data is a JSON-Patch array applied to the document
//   - op="delete" → tombstone (document becomes absent)
//
// Replaying in (seq, op_index) order up to a target seq yields the document as
// of that point in the space's total order. This is the autopsy primitive:
// value-at-seq with no live runtime.
//
// Patch application reuses the SERVER's applier (`@commonfabric/memory/v2/patch`)
// rather than a re-implementation. That matters for fidelity: the server's
// JSON-Patch dialect includes a custom `splice` op and has specific add/remove
// strictness and missing-key creation semantics that a hand-rolled RFC-6902
// applier would get subtly wrong. `applyPatch` is offline-safe (pure value ops;
// no live runtime/cell). See packages/memory/v2/patch.ts.

import { applyPatch } from "@commonfabric/memory/v2/patch";
import type { PatchOp } from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/api";

import type { SpaceDb } from "./db.ts";
import { decodeStored } from "./decode.ts";

export interface EntityAddress {
  id: string;
  scope?: string;
  branch?: string;
}

export interface ReconstructOptions extends EntityAddress {
  /** Replay revisions with seq <= atSeq. Defaults to latest. */
  atSeq?: number;
  /**
   * When set, cut the replay precisely AT (atSeq, atOpIndex): include rows with
   * `seq < atSeq`, or `seq === atSeq && op_index <= atOpIndex`. Lets a timeline
   * reconstruct the state immediately after one op of a multi-op commit.
   */
  atOpIndex?: number;
}

export type EntityDocument =
  & { value?: unknown; source?: unknown }
  & Record<
    string,
    unknown
  >;

/** Navigate into a value by a JSON path (array of keys). Display-only. */
export function getAtPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      cur = cur[key === "-" ? cur.length : Number(key)];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

interface RevRow {
  seq: number;
  op_index: number;
  op: string;
  data: string | null;
}

interface BranchLineageEntry {
  branch: string;
  /** Highest seq this branch contributes to the child's visible history. */
  maxSeq: number;
}

/**
 * The branch lineage a reader on `branch` sees at `atSeq`, mirroring the
 * engine's `readRowForBranch` recursion (`engine.ts`): the branch contributes
 * its own revisions up to `atSeq`, then inherits its parent's revisions capped
 * at `min(atSeq, fork_seq)`, recursively up to the root. On DBs without a
 * `branch` table (legacy/partial), there is no inheritance — a single branch.
 */
function branchLineage(
  space: SpaceDb,
  branch: string,
  atSeq: number,
): BranchLineageEntry[] {
  const chain: BranchLineageEntry[] = [{ branch, maxSeq: atSeq }];
  if (
    !space.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='branch'",
    ).get<{ 1: number }>()
  ) {
    return chain;
  }
  const stmt = space.db.prepare(
    "SELECT parent_branch, fork_seq FROM branch WHERE name = ?",
  );
  const seen = new Set<string>([branch]);
  let cursor = branch;
  let ceiling = atSeq;
  // Walk parent pointers; the seq ceiling only ever tightens (min with fork_seq).
  for (;;) {
    const row = stmt.get<
      { parent_branch: string | null; fork_seq: number | null }
    >(
      cursor,
    );
    // The default branch is named "" (falsy) — test for null/undefined, never
    // truthiness, or inheritance from the default branch is silently dropped.
    const parent = row?.parent_branch;
    if (parent === null || parent === undefined || seen.has(parent)) break;
    ceiling = Math.min(ceiling, row?.fork_seq ?? ceiling);
    chain.push({ branch: parent, maxSeq: ceiling });
    seen.add(parent);
    cursor = parent;
  }
  return chain;
}

/**
 * Replay the revision log to reconstruct an entity document at a (branch, seq).
 *
 * Replays the FULL effective log rather than the engine's snapshot/base-finding
 * optimization: revisions are append-only (never pruned — `compactSnapshots`
 * prunes only snapshots), so a from-scratch replay is identical to the engine's
 * result while staying robust on partial/legacy DBs that lack a snapshot table.
 * Branch inheritance is honored via {@link branchLineage}, so a child branch
 * that holds only patches still reconstructs on its inherited parent base —
 * matching `read()`/`reconstructPatchedDocument` in `packages/memory/v2`.
 */
export function reconstructDocument(
  space: SpaceDb,
  opts: ReconstructOptions,
): EntityDocument | undefined {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const atSeq = opts.atSeq ?? Number.MAX_SAFE_INTEGER;

  const stmt = space.db.prepare(
    `SELECT seq, op_index, op, data FROM revision
     WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ?
     ORDER BY seq ASC, op_index ASC`,
  );
  const rows: RevRow[] = [];
  for (const entry of branchLineage(space, branch, atSeq)) {
    rows.push(...stmt.all<RevRow>(entry.branch, opts.id, scope, entry.maxSeq));
  }
  // Lineage entries may overlap in seq space only across different branches;
  // a global (seq, op_index) sort restores the total order the reader sees.
  rows.sort((a, b) => a.seq - b.seq || a.op_index - b.op_index);

  // Optional op-precise cut within the final seq (for per-write timelines).
  const cutOpIndex = opts.atOpIndex;
  const replay = cutOpIndex === undefined
    ? rows
    : rows.filter((r) => r.seq < atSeq || r.op_index <= cutOpIndex);

  let doc: FabricValue | undefined = undefined;
  for (const row of replay) {
    if (row.op === "set") {
      doc = row.data ? (decodeStored(row.data) as FabricValue) : undefined;
    } else if (row.op === "patch") {
      // A leading patch with no base applies onto an empty document `{}`, as the
      // engine does (`emptyEntityDocument()` in reconstructPatchedDocument) —
      // never skip it, or a patch-first entity reconstructs as absent.
      const ops = row.data ? (decodeStored(row.data) as PatchOp[]) : [];
      doc = applyPatch((doc ?? {}) as FabricValue, ops);
    } else if (row.op === "delete") {
      doc = undefined;
    }
  }
  return doc as EntityDocument | undefined;
}

export interface ValueAtResult {
  exists: boolean;
  /** The full reconstructed document (`{ value, source, … }`). */
  document?: EntityDocument;
  /** The value navigated to `path` within `document.value`. */
  value?: unknown;
}

/** Reconstruct then navigate into `document.value` by path. */
export function getValueAt(
  space: SpaceDb,
  opts: ReconstructOptions,
  path: string[] = [],
): ValueAtResult {
  const document = reconstructDocument(space, opts);
  if (document === undefined) return { exists: false };
  const value = getAtPath(document.value, path);
  return { exists: true, document, value };
}

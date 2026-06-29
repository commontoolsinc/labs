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

const MAX_SEQ = Number.MAX_SAFE_INTEGER;
const MAX_OP = Number.MAX_SAFE_INTEGER;

/** Does this DB carry a given table? (legacy/partial DBs lack branch/snapshot.) */
function hasTable(space: SpaceDb, name: string): boolean {
  return !!space.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get<{ 1: number }>(name);
}

/**
 * Resolve the single revision row visible for `id` at `(atSeq, atOpIndex)` on
 * `branch`, replicating the engine's `readRowForBranch` (`engine.ts`): take the
 * latest local row at/before the cut; if the branch has NONE, inherit the
 * parent's row at `min(cut, fork_seq)`, recursively to the root. Inheritance
 * resolves WHICH branch owns the visible row — it does NOT merge logs.
 */
function resolveBranchRow(
  space: SpaceDb,
  branch: string,
  scope: string,
  id: string,
  atSeq: number,
  atOpIndex: number,
  seen: Set<string> = new Set(),
): { row: RevRow; branch: string } | undefined {
  if (seen.has(branch)) return undefined;
  seen.add(branch);

  const row = space.db
    .prepare(
      `SELECT seq, op_index, op, data FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ?
         AND (seq < ? OR (seq = ? AND op_index <= ?))
       ORDER BY seq DESC, op_index DESC LIMIT 1`,
    )
    .get<RevRow>(branch, id, scope, atSeq, atSeq, atOpIndex);
  if (row) return { row, branch };

  if (!hasTable(space, "branch")) return undefined;
  const b = space.db
    .prepare("SELECT parent_branch, fork_seq FROM branch WHERE name = ?")
    .get<{ parent_branch: string | null; fork_seq: number | null }>(branch);
  // The default branch is named "" (falsy) — test for null/undefined, not truthiness.
  if (!b || b.parent_branch === null || b.parent_branch === undefined) {
    return undefined;
  }
  // Inherit at min(seq, fork_seq), with `?? 0` matching the engine's fallback
  // exactly (engine.ts) — a malformed null fork_seq must not leak the parent's
  // post-fork head into the child.
  const inheritedSeq = Math.min(atSeq, b.fork_seq ?? 0);
  return resolveBranchRow(
    space,
    b.parent_branch,
    scope,
    id,
    inheritedSeq,
    MAX_OP,
    seen,
  );
}

/**
 * Reconstruct a patched document WITHIN a single branch, replicating the
 * engine's `reconstructPatchedDocument`: pick a base — the latest `snapshot`
 * (if present and at/after the latest `set`/`delete`) else the latest
 * `set`/`delete` at/before `(rowSeq, rowOpIndex)` — then apply that branch's
 * `patch` rows strictly after the base up to the cut. A `set`/snapshot decodes
 * to its document; a `delete` (or no base) starts from `{}`. No cross-branch
 * composition: a child-local patch with no child base starts from `{}`, exactly
 * as the runtime reads it (NOT the inherited parent value).
 */
function reconstructWithinBranch(
  space: SpaceDb,
  branch: string,
  scope: string,
  id: string,
  rowSeq: number,
  rowOpIndex: number,
): FabricValue {
  const base = space.db
    .prepare(
      `SELECT seq, op_index, op, data FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ? AND op IN ('set','delete')
         AND (seq < ? OR (seq = ? AND op_index <= ?))
       ORDER BY seq DESC, op_index DESC LIMIT 1`,
    )
    .get<RevRow>(branch, id, scope, rowSeq, rowSeq, rowOpIndex);

  let doc: FabricValue =
    (base && base.op === "set" && base.data
      ? (decodeStored(base.data) as FabricValue)
      : {}) as FabricValue;
  let baseSeq = base ? base.seq : 0;
  let baseOpIndex = base ? base.op_index : -1;

  // Prefer a snapshot base when it's at/after the set/delete base — the engine
  // does this for speed AND it future-proofs against any revision compaction
  // behind a snapshot. The snapshot is keyed by seq only and represents the full
  // materialized document at that seq, so patches strictly AFTER its seq apply.
  if (hasTable(space, "snapshot")) {
    const snap = space.db
      .prepare(
        `SELECT seq, value FROM snapshot
         WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get<{ seq: number; value: string }>(branch, id, scope, rowSeq);
    if (snap && snap.seq >= baseSeq) {
      doc = decodeStored(snap.value) as FabricValue;
      baseSeq = snap.seq;
      baseOpIndex = MAX_OP; // patches with seq > snapshot.seq only
    }
  }

  const patches = space.db
    .prepare(
      `SELECT seq, op_index, op, data FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ? AND op = 'patch'
         AND (seq > ? OR (seq = ? AND op_index > ?))
         AND (seq < ? OR (seq = ? AND op_index <= ?))
       ORDER BY seq ASC, op_index ASC`,
    )
    .all<RevRow>(
      branch,
      id,
      scope,
      baseSeq,
      baseSeq,
      baseOpIndex,
      rowSeq,
      rowSeq,
      rowOpIndex,
    );
  for (const p of patches) {
    const ops = p.data ? (decodeStored(p.data) as PatchOp[]) : [];
    doc = applyPatch(doc, ops);
  }
  return doc;
}

/**
 * Reconstruct an entity document at a (branch, seq) by replicating the engine's
 * read path (`read()` → `readRowForBranch` → `reconstructPatchedDocument` in
 * `packages/memory/v2`), proven identical by `reconstruct-parity.test.ts` which
 * drives the real engine. Branch inheritance resolves the visible ROW (not a
 * merged log); patched reconstruction stays within the resolved branch.
 */
export function reconstructDocument(
  space: SpaceDb,
  opts: ReconstructOptions,
): EntityDocument | undefined {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const atSeq = opts.atSeq ?? MAX_SEQ;
  const atOpIndex = opts.atOpIndex ?? MAX_OP;

  const resolved = resolveBranchRow(
    space,
    branch,
    scope,
    opts.id,
    atSeq,
    atOpIndex,
  );
  if (!resolved) return undefined;

  const { row, branch: rb } = resolved;
  if (row.op === "set") {
    return (row.data ? decodeStored(row.data) : undefined) as
      | EntityDocument
      | undefined;
  }
  if (row.op === "delete") return undefined;
  // patch: reconstruct within the branch that owns the resolved row.
  return reconstructWithinBranch(
    space,
    rb,
    scope,
    opts.id,
    row.seq,
    row.op_index,
  ) as EntityDocument;
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

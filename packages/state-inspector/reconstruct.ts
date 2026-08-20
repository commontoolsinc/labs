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
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";

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
}

export type EntityDocument =
  & { value?: unknown; source?: unknown }
  & Record<
    string,
    unknown
  >;

export interface PathSelection {
  /** Whether every segment selected an own property. */
  found: boolean;
  /** The selected value. This can be `undefined` when `found` is true. */
  value: unknown;
}

/**
 * Navigates own properties using exact string segments and reports whether the
 * selected property exists. Array segments must be canonical array-index
 * property names.
 */
export function selectAtPath(
  root: unknown,
  path: string[],
): PathSelection {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null) return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      if (!isArrayIndexPropertyName(key)) {
        return { found: false, value: undefined };
      }
      const index = Number(key);
      if (!Object.hasOwn(cur, index)) {
        return { found: false, value: undefined };
      }
      cur = cur[index];
    } else {
      const boxed = Object(cur) as Record<string, unknown>;
      if (!Object.hasOwn(boxed, key)) {
        return { found: false, value: undefined };
      }
      cur = boxed[key];
    }
  }
  return { found: true, value: cur };
}

/**
 * Navigates own properties using exact string segments. Array segments must be
 * canonical array-index property names.
 */
export function getAtPath(root: unknown, path: string[]): unknown {
  return selectAtPath(root, path).value;
}

interface RevRow {
  seq: number;
  op_index: number;
  op: string;
  data: string | null;
}

const MAX_SEQ = Number.MAX_SAFE_INTEGER;

/** Does this DB carry a given table? (legacy/partial DBs lack branch/snapshot.) */
function hasTable(space: SpaceDb, name: string): boolean {
  return !!space.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get<{ 1: number }>(name);
}

/**
 * Resolve the single revision row visible for `id` at `atSeq` on `branch`,
 * replicating the engine's `readRowForBranch` (`engine.ts`): take the latest
 * local row at/before `atSeq`; if the branch has NONE, inherit the parent's row
 * at `min(atSeq, fork_seq)`, recursively to the root. Inheritance resolves WHICH
 * branch owns the visible row — it does NOT merge logs.
 */
function resolveBranchRow(
  space: SpaceDb,
  branch: string,
  scope: string,
  id: string,
  atSeq: number,
  seen: Set<string> = new Set(),
): { row: RevRow; branch: string } | undefined {
  if (seen.has(branch)) return undefined;
  seen.add(branch);

  const row = space.db
    .prepare(
      `SELECT seq, op_index, op, data FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ?
       ORDER BY seq DESC, op_index DESC LIMIT 1`,
    )
    .get<RevRow>(branch, id, scope, atSeq);
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

  let doc: FabricValue = base && base.op === "set" && base.data
    ? (decodeStored(base.data) as FabricValue)
    : {};
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
      baseOpIndex = MAX_SEQ; // patches with seq > snapshot.seq only
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
 * The result of reconstructing an entity, naming WHY there is no document when
 * there is none. Four unrelated situations leave an entity without a document
 * at a (branch, seq), and a reader told only "no document" cannot tell a routine
 * deletion from a corrupt payload. `reconstructDocument` collapses them back to
 * `undefined` for callers that do not care; the ones that report entities to a
 * human read this instead.
 */
export type ReconstructOutcome =
  | { status: "present"; document: EntityDocument }
  /** The visible head row is a `delete` — the entity was removed. */
  | { status: "deleted" }
  /** The visible head row is a `set` that stored no data. */
  | { status: "empty" }
  /** No revision row is visible at this (branch, scope, seq). */
  | { status: "absent" }
  /** The stored payload did not decode. `error` is the original throw. */
  | { status: "undecodable"; error: unknown };

/** The `status` values that carry no document. */
export type AbsenceStatus = Exclude<ReconstructOutcome["status"], "present">;

/**
 * Reconstruct an entity document at a (branch, seq) by replicating the engine's
 * read path (`read()` → `readRowForBranch` → `reconstructPatchedDocument` in
 * `packages/memory/v2`), proven identical by `reconstruct-parity.test.ts` which
 * drives the real engine. Branch inheritance resolves the visible ROW (not a
 * merged log); patched reconstruction stays within the resolved branch.
 *
 * A decode failure is returned as `undecodable` rather than thrown, so that one
 * corrupt entity does not abort a walk over a whole space.
 */
export function reconstructOutcome(
  space: SpaceDb,
  opts: ReconstructOptions,
): ReconstructOutcome {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const atSeq = opts.atSeq ?? MAX_SEQ;

  const resolved = resolveBranchRow(space, branch, scope, opts.id, atSeq);
  if (!resolved) return { status: "absent" };

  const { row, branch: rb } = resolved;
  if (row.op === "delete") return { status: "deleted" };
  try {
    if (row.op === "set") {
      if (!row.data) return { status: "empty" };
      return {
        status: "present",
        document: decodeStored(row.data) as EntityDocument,
      };
    }
    // patch: reconstruct within the branch that owns the resolved row.
    return {
      status: "present",
      document: reconstructWithinBranch(
        space,
        rb,
        scope,
        opts.id,
        row.seq,
        row.op_index,
      ) as EntityDocument,
    };
  } catch (error) {
    return { status: "undecodable", error };
  }
}

/**
 * The document an entity holds at a (branch, seq), or `undefined` when it holds
 * none. Throws the decode error for a payload that does not decode. Callers that
 * distinguish a tombstone from corruption call {@link reconstructOutcome}.
 */
export function reconstructDocument(
  space: SpaceDb,
  opts: ReconstructOptions,
): EntityDocument | undefined {
  const outcome = reconstructOutcome(space, opts);
  if (outcome.status === "undecodable") throw outcome.error;
  return outcome.status === "present" ? outcome.document : undefined;
}

export interface ValueAtResult {
  exists: boolean;
  /** The full reconstructed document (`{ value, source, … }`). */
  document?: EntityDocument;
  /** The value navigated to `path` within `document.value`. */
  value?: unknown;
}

/** A reconstructed value result that distinguishes a missing selected path. */
export interface SelectedValueAtResult extends ValueAtResult {
  /** Whether the requested path exists within a reconstructed document. */
  pathExists: boolean;
}

/** Reconstruct then navigate into `document.value` by path. */
export function getValueAt(
  space: SpaceDb,
  opts: ReconstructOptions,
  path: string[] = [],
): SelectedValueAtResult {
  const document = reconstructDocument(space, opts);
  if (document === undefined) return { exists: false, pathExists: false };
  if (!Object.hasOwn(document, "value")) {
    return { exists: true, document, pathExists: false };
  }
  const selected = selectAtPath(document.value, path);
  return {
    exists: true,
    document,
    pathExists: selected.found,
    value: selected.value,
  };
}

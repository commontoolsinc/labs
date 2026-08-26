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

/** One branch a read consults, and the seq its rows are visible up to. */
export interface BranchReadLink {
  branch: string;

  /** Rows with `seq <= atSeq` on this branch are visible from the read. */
  atSeq: number;
}

// A chain depends on the `branch` table, which an offline space file does not
// gain while we hold it open read-only, so it is derived once per (space,
// branch, seq) and reused. Without this a space-wide scan would re-derive the
// same chain for every entity it reconstructs.
const chainCache = new WeakMap<SpaceDb, Map<string, BranchReadLink[]>>();

/**
 * The branches a read on `branch` at `atSeq` consults, nearest first, each with
 * the seq it is read at — the engine's `readRowForBranch` ancestry (`engine.ts`)
 * resolved as a list instead of walked per entity.
 *
 * This is the ONE encoding of "what can a read on this branch see". A read
 * resolves the first link that holds a row; a space-wide scan enumerates the
 * union across links. Both have to agree, or a listing reports itself complete
 * while omitting entities the same branch reads fine.
 */
export function branchReadChain(
  space: SpaceDb,
  branch: string,
  atSeq: number = MAX_SEQ,
): BranchReadLink[] {
  let perSpace = chainCache.get(space);
  if (!perSpace) chainCache.set(space, perSpace = new Map());
  const key = `${atSeq}\u0000${branch}`;
  const hit = perSpace.get(key);
  if (hit) return hit;

  const chain: BranchReadLink[] = [];
  const seen = new Set<string>();
  let current = branch;
  let cut = atSeq;
  // `seen` guards a malformed cycle in `parent_branch`; without it a space
  // whose branch table points back at itself would recur forever.
  while (!seen.has(current)) {
    seen.add(current);
    chain.push({ branch: current, atSeq: cut });
    if (!hasTable(space, "branch")) break;
    const b = space.db
      .prepare("SELECT parent_branch, fork_seq FROM branch WHERE name = ?")
      .get<{ parent_branch: string | null; fork_seq: number | null }>(current);
    // The default branch is named "" (falsy) — test for null/undefined, not truthiness.
    if (!b || b.parent_branch === null || b.parent_branch === undefined) break;
    // Inherit at min(seq, fork_seq), with `?? 0` matching the engine's fallback
    // exactly (engine.ts) — a malformed null fork_seq must not leak the parent's
    // post-fork head into the child.
    cut = Math.min(cut, b.fork_seq ?? 0);
    current = b.parent_branch;
  }
  perSpace.set(key, chain);
  return chain;
}

/** One (scope, entity) a read on a branch can see, and where it comes from. */
export interface VisibleRevisionRow {
  scope: string;
  id: string;

  /** Revisions on the branch that OWNS it — the history a read can reach. */
  revisions: number;

  /** The chain link that owns it. */
  link: BranchReadLink;
}

/**
 * Every (scope, entity) this branch has RECORDS for, each attributed to the
 * nearest branch holding it — `resolveBranchRow`'s rule applied to a whole
 * space instead of one entity.
 *
 * Records, not readable entities: an entity whose head is a `delete` is
 * enumerated here, because a tombstone is something the branch holds and
 * several callers need to know about it. `visibleEntityRows` is the read-
 * visible set, and drops them. Do not mistake one for the other — the reason
 * this function exists is that the ancestry rule was being written once per
 * caller and drifting one caller at a time, and a caller that reads this as
 * "what a read returns" reintroduces exactly that.
 *
 * Enumeration and reading have to agree about what a branch can see, or a view
 * reports one domain while describing another: a listing that covers inherited
 * entities beside a scope list that does not, or a page naming a per-user scope
 * while showing no cells in it. Narrow with `scope` or `id` when only part of
 * the space is wanted; the remaining shape is identical either way.
 */
export function visibleRevisionRows(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; id?: string } = {},
): VisibleRevisionRow[] {
  const conditions = ["branch = ?", "seq <= ?"];
  if (opts.scope !== undefined) conditions.push("scope_key = ?");
  if (opts.id !== undefined) conditions.push("id = ?");
  const stmt = space.db.prepare(
    `SELECT scope_key, id, count(*) revs FROM revision
     WHERE ${conditions.join(" AND ")} GROUP BY scope_key, id`,
  );
  const rows: VisibleRevisionRow[] = [];
  const claimed = new Set<string>();
  for (const link of branchReadChain(space, opts.branch ?? "")) {
    const params: (string | number)[] = [link.branch, link.atSeq];
    if (opts.scope !== undefined) params.push(opts.scope);
    if (opts.id !== undefined) params.push(opts.id);
    for (
      const r of stmt.all<{ scope_key: string; id: string; revs: number }>(
        ...params,
      )
    ) {
      const key = `${r.scope_key}\u0000${r.id}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      rows.push({ scope: r.scope_key, id: r.id, revisions: r.revs, link });
    }
  }
  return rows;
}

/**
 * Resolve the single revision row visible for `id` at `atSeq` on `branch`,
 * replicating the engine's `readRowForBranch` (`engine.ts`): take the latest
 * local row at/before `atSeq`; if the branch has NONE, inherit the parent's row
 * at `min(atSeq, fork_seq)`, on up to the root. Inheritance resolves WHICH
 * branch owns the visible row — it does NOT merge logs.
 */
function resolveBranchRow(
  space: SpaceDb,
  branch: string,
  scope: string,
  id: string,
  atSeq: number,
): { row: RevRow; branch: string } | undefined {
  const stmt = space.db.prepare(
    `SELECT seq, op_index, op, data FROM revision
     WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ?
     ORDER BY seq DESC, op_index DESC LIMIT 1`,
  );
  for (const link of branchReadChain(space, branch, atSeq)) {
    const row = stmt.get<RevRow>(link.branch, id, scope, link.atSeq);
    if (row) return { row, branch: link.branch };
  }
  return undefined;
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

  const resolved = resolveBranchRow(space, branch, scope, opts.id, atSeq);
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

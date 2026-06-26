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
}

export type EntityDocument = { value?: unknown; source?: unknown } & Record<
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

/** Replay the revision log to reconstruct an entity document at a seq. */
export function reconstructDocument(
  space: SpaceDb,
  opts: ReconstructOptions,
): EntityDocument | undefined {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const atSeq = opts.atSeq ?? Number.MAX_SAFE_INTEGER;

  const rows = space.db
    .prepare(
      `SELECT seq, op_index, op, data FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ?
       ORDER BY seq ASC, op_index ASC`,
    )
    .all<RevRow>(branch, opts.id, scope, atSeq);

  let doc: FabricValue | undefined = undefined;
  for (const row of rows) {
    if (row.op === "set") {
      doc = row.data ? (decodeStored(row.data) as FabricValue) : undefined;
    } else if (row.op === "patch") {
      // A patch with no prior document is anomalous (the server always lays a
      // set first); skip rather than feed `undefined` to the applier.
      if (doc === undefined) continue;
      const ops = row.data ? (decodeStored(row.data) as PatchOp[]) : [];
      doc = applyPatch(doc, ops);
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

// State-at-(branch, seq) reconstruction by replaying the append-only revision log.
//
// A memory v2 entity document has the shape `{ value: <FabricValue>, source?: … }`.
// Each `revision` row is one operation on that document:
//   - op="set"    → data is the whole replacement document
//   - op="patch"  → data is an RFC 6902 JSON-Patch array applied to the document
//   - op="delete" → tombstone (document becomes absent)
//
// Replaying in (seq, op_index) order up to a target seq yields the document as
// of that point in the space's total order. This is the autopsy primitive:
// value-at-seq with no live runtime.
//
// NOTE: the JSON-Patch applier here implements standard RFC 6902. The server's
// own applier (packages/memory/v2/patch.ts) is ground truth; cross-check before
// trusting reconstruction in anything load-bearing.

import type { SpaceDb } from "./db.ts";

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

interface PatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getAt(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = key === "-" ? cur.length : Number(key);
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setAt(root: unknown, path: string[], value: unknown, add: boolean): unknown {
  if (path.length === 0) return value;
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (parent == null) return root;
  if (Array.isArray(parent)) {
    const idx = key === "-" ? parent.length : Number(key);
    if (add) parent.splice(idx, 0, value);
    else parent[idx] = value;
  } else if (typeof parent === "object") {
    (parent as Record<string, unknown>)[key] = value;
  }
  return root;
}

function removeAt(root: unknown, path: string[]): unknown {
  if (path.length === 0) return undefined;
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (parent == null) return root;
  if (Array.isArray(parent)) {
    parent.splice(Number(key), 1);
  } else if (typeof parent === "object") {
    delete (parent as Record<string, unknown>)[key];
  }
  return root;
}

export function applyJsonPatch(doc: unknown, ops: PatchOp[]): unknown {
  let root = doc;
  for (const op of ops) {
    const path = parsePointer(op.path);
    switch (op.op) {
      case "add":
        root = setAt(root, path, op.value, true);
        break;
      case "replace":
        root = setAt(root, path, op.value, false);
        break;
      case "remove":
        root = removeAt(root, path);
        break;
      case "move": {
        const from = parsePointer(op.from ?? "");
        const val = getAt(root, from);
        root = removeAt(root, from);
        root = setAt(root, path, val, true);
        break;
      }
      case "copy": {
        const from = parsePointer(op.from ?? "");
        const val = structuredClone(getAt(root, from));
        root = setAt(root, path, val, true);
        break;
      }
      case "test":
        // Verification op; ignored for reconstruction.
        break;
    }
  }
  return root;
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

  let doc: unknown = undefined;
  for (const row of rows) {
    if (row.op === "set") {
      doc = row.data ? JSON.parse(row.data) : undefined;
    } else if (row.op === "patch") {
      doc = applyJsonPatch(doc, row.data ? JSON.parse(row.data) : []);
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
  const value = getAt(document.value, path);
  return { exists: true, document, value };
}

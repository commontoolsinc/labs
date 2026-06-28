// The unified entity model — what makes the inspector *fluent* instead of
// guessing from `doc.value`.
//
// A memory v2 entity stores ONE document (`is`) per id, and that document is a
// TREE of top-level paths. The reactive value lives at `value`; the control
// plane lives at sibling meta paths on the SAME entity:
//
//   value           the reactive value (a cell's contents)
//   argument        SigilLink → the piece's INPUT cell
//   result          SigilLink → the OWNING piece's result cell (ownership back-link)
//   patternIdentity { identity, symbol } → the durable piece → pattern(module) pointer
//   internal        manifest [{ partialCause, link }] of the piece's owned child cells
//   schema          the result's JSONSchema
//   cfc             information-flow label map
//   pattern/slug    other piece metadata
//
// Classifying by *which top-level paths exist* (plus the shape of `value`) tells
// us what an entity actually IS. Ground-truthed against a real modern space
// (145 entities): pieces carry {argument, internal, patternIdentity, schema,
// value}; owned cells carry {result(, value)}; free cells carry {value}.
//
// Two regimes:
//   modern (post-#3522 "Remove Process Cell") — pieces carry `patternIdentity`.
//   legacy (pre-#3522) — a separate process cell whose `value` carries
//     { $TYPE, resultRef, … }; the result cell links to it via `source`.
// We classify both; modern is the verified path, legacy is best-effort.

import type { SpaceDb } from "./db.ts";
import { countLinks, parseSigilLink, summarize } from "./decode.ts";
import { reconstructDocument } from "./reconstruct.ts";
import type { EntityDocument, ReconstructOptions } from "./reconstruct.ts";

export type EntityKind =
  | "piece" // a running pattern instance (result cell + lineage meta)
  | "module" // pattern source/compiled module (value carries code + identity)
  | "stream" // write-only event channel (value.$stream === true)
  | "schema" // a JSONSchema stored as a cell value
  | "owned-cell" // a cell owned by a piece (carries a `result` back-link)
  | "free-cell" // a standalone cell, owned by no piece
  | "unknown";

export type Regime = "modern" | "legacy" | "n/a";

export type ValueShape =
  | "stream"
  | "module"
  | "schema"
  | "piece-result"
  | "object"
  | "array"
  | "scalar"
  | "absent";

/** Resolved lineage links for an entity (ids only — targets are not followed). */
export interface Lineage {
  /** Input cell — a piece's `argument` link target. */
  argument?: string;
  /** Pattern pointer + resolved module entity (modern pieces). */
  pattern?: { identity: string; symbol?: string; moduleId?: string };
  /** Owning piece — an owned cell's `result` back-link target. */
  owner?: string;
  /** Owned child cell ids — a piece's `internal` manifest. */
  internal?: string[];
  /** Legacy process/source cell link target. */
  source?: string;
}

export interface EntityModel {
  id: string;
  scope: string;
  kind: EntityKind;
  regime: Regime;
  /** True when the entity carries a `result` ownership back-link. */
  owned: boolean;
  /** Human label: piece $NAME, module:<file>, stream, schema, or value summary. */
  label: string;
  /** Top-level paths present in the document (the control plane, sorted). */
  paths: string[];
  valueShape: ValueShape;
  lineage: Lineage;
  revisions?: number;
  links?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The target id of a SigilLink value, if it is one. */
function linkId(v: unknown): string | undefined {
  return parseSigilLink(v)?.id ?? undefined;
}

/** Owned child cell ids from a piece's `internal` manifest. */
function internalIds(internal: unknown): string[] {
  if (!Array.isArray(internal)) return [];
  const out: string[] = [];
  for (const el of internal) {
    if (isObj(el) && "link" in el) {
      const id = linkId(el.link);
      if (id) out.push(id);
    }
  }
  return out;
}

function basename(p: string): string {
  return p.split("/").pop() || p;
}

/** A value shaped like a module: `{ code, identity, … }`. */
export function isModuleValue(
  v: unknown,
): v is { code: string; identity: string; filename?: string; kind?: string } {
  return isObj(v) && typeof v.code === "string" &&
    typeof v.identity === "string";
}

/** A value shaped like a JSONSchema stored as data: `{ type, properties|$defs }`. */
function isSchemaValue(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (typeof v.type !== "string") return false;
  if (!(isObj(v.properties) || isObj(v.$defs))) return false;
  // Schemas-as-data don't carry render markers.
  return !("$UI" in v) && !("$NAME" in v);
}

function isStreamValue(v: unknown): boolean {
  return isObj(v) && v.$stream === true;
}

/** A piece result value: carries render/name markers. */
function isPieceResultValue(v: unknown): boolean {
  return isObj(v) && ("$UI" in v || "$NAME" in v || "$TILE_UI" in v);
}

/** A legacy process cell value: `{ $TYPE, resultRef|spell|source, … }`. */
function isLegacyProcessValue(
  v: unknown,
): v is {
  $TYPE: string;
  resultRef?: unknown;
  argument?: unknown;
  spell?: unknown;
  source?: unknown;
} {
  return isObj(v) && typeof v.$TYPE === "string" &&
    ("resultRef" in v || "spell" in v || "source" in v);
}

function valueShapeOf(v: unknown): ValueShape {
  if (v === undefined) return "absent";
  if (isStreamValue(v)) return "stream";
  if (isModuleValue(v)) return "module";
  if (isSchemaValue(v)) return "schema";
  if (isPieceResultValue(v)) return "piece-result";
  if (Array.isArray(v)) return "array";
  if (isObj(v)) return "object";
  return "scalar";
}

/** Module label, e.g. `module:foo.tsx` or `module:foo.tsx (compiled)`. */
function moduleLabel(v: { filename?: string; kind?: string }): string {
  const file = v.filename ? basename(v.filename) : "?";
  const k = v.kind && v.kind !== "source" ? ` (${v.kind})` : "";
  return `module:${file}${k}`;
}

export interface Classification {
  kind: EntityKind;
  regime: Regime;
  owned: boolean;
  label: string;
  paths: string[];
  valueShape: ValueShape;
  lineage: Lineage;
}

/**
 * Classify a reconstructed entity document by its top-level path-set and value
 * shape. Pure: resolves lineage to link-target ids but does not follow them or
 * resolve `patternIdentity` to a module (that needs the space-wide module index;
 * see {@link modelEntity}).
 */
export function classifyDocument(doc: EntityDocument): Classification {
  const paths = Object.keys(doc).sort();
  const value = doc.value;
  const owned = "result" in doc;
  const valueShape = valueShapeOf(value);
  const lineage: Lineage = {};
  if (owned) lineage.owner = linkId(doc.result);

  // --- Pieces -------------------------------------------------------------
  // Modern: the durable piece → pattern pointer is `patternIdentity`.
  if (isObj(doc.patternIdentity)) {
    const pi = doc.patternIdentity as { identity?: unknown; symbol?: unknown };
    lineage.argument = linkId(doc.argument);
    lineage.internal = internalIds(doc.internal);
    if (typeof pi.identity === "string") {
      lineage.pattern = {
        identity: pi.identity,
        symbol: typeof pi.symbol === "string" ? pi.symbol : undefined,
      };
    }
    const name = isObj(value) && typeof value.$NAME === "string"
      ? value.$NAME
      : undefined;
    return {
      kind: "piece",
      regime: "modern",
      owned,
      label: name || "(piece)",
      paths,
      valueShape,
      lineage,
    };
  }
  // Legacy: a process cell carries `{ $TYPE, resultRef, … }`.
  if (isLegacyProcessValue(value)) {
    lineage.source = linkId(value.resultRef) ?? linkId(value.source);
    lineage.argument = linkId(value.argument);
    return {
      kind: "piece",
      regime: "legacy",
      owned,
      label: "(piece, legacy process)",
      paths,
      valueShape,
      lineage,
    };
  }
  // Legacy: a result cell links to its process cell via top-level `source`.
  if ("source" in doc && isPieceResultValue(value)) {
    lineage.source = linkId(doc.source);
    const name = isObj(value) && typeof value.$NAME === "string"
      ? value.$NAME
      : undefined;
    return {
      kind: "piece",
      regime: "legacy",
      owned,
      label: name || "(piece, legacy)",
      paths,
      valueShape,
      lineage,
    };
  }

  // --- Cell sub-kinds by value shape -------------------------------------
  if (isModuleValue(value)) {
    return {
      kind: "module",
      regime: "n/a",
      owned,
      label: moduleLabel(value),
      paths,
      valueShape,
      lineage,
    };
  }
  if (isStreamValue(value)) {
    return {
      kind: "stream",
      regime: "n/a",
      owned,
      label: "⊙ stream",
      paths,
      valueShape,
      lineage,
    };
  }
  if (isSchemaValue(value)) {
    const ifc = isObj(value) && "ifc" in value ? "+ifc" : "";
    return {
      kind: "schema",
      regime: "n/a",
      owned,
      label: `schema${ifc}`,
      paths,
      valueShape,
      lineage,
    };
  }

  // --- Plain cells -------------------------------------------------------
  if (owned) {
    const label = value === undefined ? "(lineage)" : summarize(value);
    return {
      kind: "owned-cell",
      regime: "n/a",
      owned,
      label,
      paths,
      valueShape,
      lineage,
    };
  }
  if ("value" in doc) {
    return {
      kind: "free-cell",
      regime: "n/a",
      owned,
      label: summarize(value),
      paths,
      valueShape,
      lineage,
    };
  }
  return {
    kind: "unknown",
    regime: "n/a",
    owned,
    label: `{${paths.join(",")}}`,
    paths,
    valueShape,
    lineage,
  };
}

export interface ModuleEntry {
  id: string;
  filename?: string;
  kind?: string;
}

/**
 * Map a module `identity` (the `patternIdentity.identity` hash) to its module
 * entity. One `.tsx` yields source + compiled entities sharing an identity; we
 * prefer the `source` entity (it holds TS code + filename).
 */
export function buildModuleIndex(
  space: SpaceDb,
  opts: { branch?: string; scope?: string } = {},
): Map<string, ModuleEntry> {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const ids = space.db
    .prepare(
      `SELECT DISTINCT id FROM revision WHERE branch = ? AND scope_key = ?`,
    )
    .all<{ id: string }>(branch, scope)
    .map((r) => r.id);

  const index = new Map<string, ModuleEntry>();
  for (const id of ids) {
    let doc: EntityDocument | undefined;
    try {
      doc = reconstructDocument(space, { id, branch, scope });
    } catch {
      continue;
    }
    const v = doc?.value;
    if (!isModuleValue(v)) continue;
    const existing = index.get(v.identity);
    // First wins, but a `source` entity always supersedes a `compiled` one.
    if (!existing || v.kind === "source") {
      index.set(v.identity, { id, filename: v.filename, kind: v.kind });
    }
  }
  return index;
}

/** Model a single entity: classify + resolve `patternIdentity` → module id. */
export function modelEntity(
  space: SpaceDb,
  address: ReconstructOptions,
  moduleIndex?: Map<string, ModuleEntry>,
): EntityModel | undefined {
  const doc = reconstructDocument(space, address);
  if (doc === undefined) return undefined;
  return modelFromDocument(doc, {
    id: address.id,
    scope: address.scope ?? "space",
    moduleIndex,
  });
}

/** Build an EntityModel from an already-reconstructed document. */
export function modelFromDocument(
  doc: EntityDocument,
  ctx: { id: string; scope?: string; moduleIndex?: Map<string, ModuleEntry> },
): EntityModel {
  const c = classifyDocument(doc);
  if (c.lineage.pattern && ctx.moduleIndex) {
    c.lineage.pattern.moduleId = ctx.moduleIndex.get(c.lineage.pattern.identity)
      ?.id;
  }
  return {
    id: ctx.id,
    scope: ctx.scope ?? "space",
    kind: c.kind,
    regime: c.regime,
    owned: c.owned,
    label: c.label,
    paths: c.paths,
    valueShape: c.valueShape,
    lineage: c.lineage,
  };
}

const KIND_ORDER: Record<EntityKind, number> = {
  piece: 0,
  module: 1,
  stream: 2,
  schema: 3,
  "owned-cell": 4,
  "free-cell": 5,
  unknown: 6,
};

/**
 * Model every entity in a space — the fluent "what is in here?" view. One
 * reconstruction pass: collect documents, build the module index from them,
 * then classify each. Sorted pieces → modules → streams → schemas → cells.
 * Replaces the old value-shape-only `listEntities` (which undercounted pieces).
 */
export function listEntityModels(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; limit?: number } = {},
): EntityModel[] {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = opts.limit ?? 5000;
  const rows = space.db
    .prepare(
      `SELECT id, count(*) revisions FROM revision
       WHERE branch = ? AND scope_key = ?
       GROUP BY id ORDER BY revisions DESC LIMIT ?`,
    )
    .all<{ id: string; revisions: number }>(branch, scope, limit);

  // Single reconstruction pass: cache docs + build the module index inline.
  const docs = new Map<string, EntityDocument | undefined>();
  const moduleIndex = new Map<string, ModuleEntry>();
  for (const r of rows) {
    let doc: EntityDocument | undefined;
    try {
      doc = reconstructDocument(space, { id: r.id, branch, scope });
    } catch {
      doc = undefined;
    }
    docs.set(r.id, doc);
    const v = doc?.value;
    if (isModuleValue(v)) {
      const existing = moduleIndex.get(v.identity);
      if (!existing || v.kind === "source") {
        moduleIndex.set(v.identity, {
          id: r.id,
          filename: v.filename,
          kind: v.kind,
        });
      }
    }
  }

  const out: EntityModel[] = rows.map((r): EntityModel => {
    const doc = docs.get(r.id);
    if (doc === undefined) {
      return {
        id: r.id,
        scope,
        kind: "unknown",
        regime: "n/a",
        owned: false,
        label: "(undecodable)",
        paths: [],
        valueShape: "absent",
        lineage: {},
        revisions: r.revisions,
        links: 0,
      };
    }
    const m = modelFromDocument(doc, { id: r.id, scope, moduleIndex });
    m.revisions = r.revisions;
    m.links = countLinks(doc.value);
    return m;
  });

  return out.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (b.revisions ?? 0) - (a.revisions ?? 0),
  );
}

export interface PieceCellRef {
  id: string;
  /** Classified kind of the owned cell (stream / schema / owned-cell / …). */
  kind: EntityKind;
  label: string;
  summary: string;
}

export interface PieceModel {
  id: string;
  regime: Regime;
  name: string;
  /** The pattern (module) this piece instantiates, resolved via patternIdentity. */
  pattern?: {
    id?: string;
    identity: string;
    symbol?: string;
    filename?: string;
    codeLines?: number;
    /** Full TS source — only populated when `includeCode` is set. */
    code?: string;
  };
  /** The piece's input cell (the `argument` link). */
  input?: { id: string; summary: string };
  /** Top-level keys of the piece's result value ($UI, $NAME, …pattern outputs). */
  resultKeys: string[];
  /** Top-level keys of the result JSONSchema. */
  schemaKeys: string[];
  /** The piece's owned child cells (its `internal` manifest, resolved). */
  ownedCells: PieceCellRef[];
}

/**
 * Resolve a piece fully: its pattern source (follow `patternIdentity` → module),
 * input cell (`argument`), result value + schema, and owned cells (`internal`).
 * Returns `{ error }` if the entity is absent or is not a piece.
 */
export function describePiece(
  space: SpaceDb,
  id: string,
  opts: {
    branch?: string;
    scope?: string;
    includeCode?: boolean;
    moduleIndex?: Map<string, ModuleEntry>;
  } = {},
): PieceModel | { error: string } {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const doc = reconstructDocument(space, { id, branch, scope });
  if (doc === undefined) return { error: "entity absent" };
  const c = classifyDocument(doc);
  if (c.kind !== "piece") return { error: `not a piece (kind=${c.kind})` };

  const value = doc.value;
  const name = isObj(value) && typeof value.$NAME === "string"
    ? value.$NAME
    : "(unnamed)";

  let pattern: PieceModel["pattern"];
  if (c.lineage.pattern) {
    const index = opts.moduleIndex ??
      buildModuleIndex(space, { branch, scope });
    const entry = index.get(c.lineage.pattern.identity);
    let codeLines: number | undefined;
    let code: string | undefined;
    if (entry) {
      const mdoc = reconstructDocument(space, { id: entry.id, branch, scope });
      const mv = mdoc?.value;
      if (isModuleValue(mv)) {
        codeLines = mv.code.split("\n").length;
        if (opts.includeCode) code = mv.code;
      }
    }
    pattern = {
      id: entry?.id,
      identity: c.lineage.pattern.identity,
      symbol: c.lineage.pattern.symbol,
      filename: entry?.filename,
      codeLines,
      code,
    };
  }

  let input: PieceModel["input"];
  if (c.lineage.argument) {
    const adoc = reconstructDocument(space, {
      id: c.lineage.argument,
      branch,
      scope,
    });
    input = {
      id: c.lineage.argument,
      summary: adoc ? summarize(adoc.value) : "(absent)",
    };
  }

  const ownedCells: PieceCellRef[] = (c.lineage.internal ?? []).map(
    (cid): PieceCellRef => {
      const cdoc = reconstructDocument(space, { id: cid, branch, scope });
      if (cdoc === undefined) {
        return {
          id: cid,
          kind: "unknown",
          label: "(absent)",
          summary: "(absent)",
        };
      }
      const cc = classifyDocument(cdoc);
      return {
        id: cid,
        kind: cc.kind,
        label: cc.label,
        summary: cc.valueShape === "absent"
          ? "(no value)"
          : summarize(cdoc.value),
      };
    },
  );

  return {
    id,
    regime: c.regime,
    name,
    pattern,
    input,
    resultKeys: isObj(value) ? Object.keys(value) : [],
    schemaKeys: isObj(doc.schema) ? Object.keys(doc.schema) : [],
    ownedCells,
  };
}

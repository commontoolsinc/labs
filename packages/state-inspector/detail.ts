// Rich per-entity detail — everything a human (or agent) needs to understand
// ONE entity, with crystal-clear, context-aware labels.
//
// The fluent model (model.ts) classifies an entity by kind. This layer goes
// further: it resolves what each cell/stream actually IS from its CONTEXT and
// VALUE, so a generic "stream" becomes "⊙ createProfile" (named by the key that
// points at it in its owner piece) and a bare "{ link, specifier }" becomes
// "import ./piece-grid.tsx". It also surfaces every salient field: the full
// value, schema, CFC (information-flow) labels, version history, resolved
// lineage, outgoing links (with target labels), and module source.
//
// Built in one reconstruction pass over the space (buildAllDetails) so link
// targets and owner→child names resolve against the whole space.

import type { SpaceDb } from "./db.ts";
import {
  annotate,
  type DecodedLink,
  parseSigilLink,
  summarize,
} from "./decode.ts";
import { reconstructDocument } from "./reconstruct.ts";
import type { EntityDocument } from "./reconstruct.ts";
import {
  classifyDocument,
  type EntityKind,
  isModuleValue,
  type ModuleEntry,
} from "./model.ts";

/** A resolved reference to another entity (or a cross-space target). */
export interface LinkRef {
  id: string;
  /** Resolved label of the target (if in this space). */
  label?: string;
  kind?: EntityKind;
  /** Cross-space target space DID. */
  space?: string;
  path?: string[];
  /** True when the target is in another space (not resolvable locally). */
  external?: boolean;
  /** Where this link sits in the source value (a JSON path), for "links" lists. */
  at?: string;
}

export interface VersionRow {
  seq: number;
  op: string;
  session: string;
  createdAt: string;
}

/** Parsed, render-ready CFC (information-flow) metadata. */
export interface CfcSummary {
  schemaHash?: string;
  entries: {
    path: string;
    confidentiality: string[];
    integrity: string[];
    origin?: string;
  }[];
}

export interface EntityDetail {
  id: string;
  kind: EntityKind;
  regime: string;
  owned: boolean;
  /** Context-aware label (key-name / import specifier / $NAME / module file). */
  label: string;
  /** Short human role, e.g. "input cell", "owned stream", "module import". */
  role: string;
  /** The key in the owner piece that names this entity, if any. */
  contextName?: string;
  /** Top-level document paths present (the control plane). */
  paths: string[];
  valueShape: string;
  /** The annotated value (links/streams normalized; depth-bounded). */
  value: unknown;
  valuePreview: string;
  /** The result JSONSchema (annotated), if the entity carries one. Streams and
   * named owned cells get their DECLARED schema resolved from the owner piece. */
  schema?: unknown;
  schemaKeys?: string[];
  /** Where `schema` came from when it isn't the entity's own (e.g. owner piece). */
  schemaSource?: string;
  /** True when the declared schema is a stream payload (`asCell:["stream"]`). */
  streamPayload?: boolean;
  /** IFC labels from a schema-as-value entity, if present. */
  ifc?: unknown;
  /** Parsed CFC labels from the `cfc` meta path, if present. */
  cfc?: CfcSummary;
  revisions: number;
  headSeq: number | null;
  firstSeq: number | null;
  versions: VersionRow[];
  lineage: {
    pattern?: LinkRef & {
      filename?: string;
      symbol?: string;
      codeLines?: number;
    };
    argument?: LinkRef;
    internal?: LinkRef[];
    owner?: LinkRef;
    /** Legacy regime: the result cell a process cell produces (`resultRef`). */
    result?: LinkRef;
  };
  /** Outgoing data links found in the value, resolved to target labels. */
  outLinks: LinkRef[];
  /** Module source (only on module entities). */
  code?: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A `{ link, specifier }` cell is a module-import entry. */
function importSpecifier(v: unknown): string | undefined {
  if (
    isObj(v) && typeof v.specifier === "string" && "link" in v &&
    Object.keys(v).length === 2
  ) return v.specifier;
  return undefined;
}

/** The `resultRef` target of a legacy process cell (`{ $TYPE, resultRef, … }`). */
function legacyResultId(v: unknown): string | undefined {
  if (isObj(v) && "$TYPE" in v && "resultRef" in v) {
    return parseSigilLink(v.resultRef)?.id;
  }
  return undefined;
}

/**
 * A legacy process cell's human name lives on its RESULT cell's `$NAME` (the
 * process cell itself only carries `$TYPE`/refs). Resolve it through the docs.
 */
function legacyName(
  v: unknown,
  docs: Map<string, EntityDocument>,
): string | undefined {
  const rid = legacyResultId(v);
  const rv = rid ? docs.get(rid)?.value : undefined;
  return isObj(rv) && typeof rv.$NAME === "string" ? rv.$NAME : undefined;
}

/** Render a CFC atom (string sigil, or an object atom) to a short string. */
function atomLabel(a: unknown): string {
  if (typeof a === "string") return a;
  if (isObj(a)) {
    const t = typeof a.type === "string" ? a.type.split("/").pop() : "atom";
    const extra = a.name ?? a.subject ?? a.class ?? a.symbol;
    return extra ? `${t}:${extra}` : String(t);
  }
  return String(a);
}

function parseCfc(cfc: unknown): CfcSummary | undefined {
  if (!isObj(cfc)) return undefined;
  const out: CfcSummary = {
    schemaHash: typeof cfc.schemaHash === "string" ? cfc.schemaHash : undefined,
    entries: [],
  };
  const lm = cfc.labelMap;
  const entries = isObj(lm) && Array.isArray(lm.entries) ? lm.entries : [];
  for (const e of entries) {
    if (!isObj(e)) continue;
    const label = isObj(e.label) ? e.label : {};
    out.entries.push({
      path: Array.isArray(e.path) ? (e.path as string[]).join("/") : "",
      confidentiality: Array.isArray(label.confidentiality)
        ? label.confidentiality.map(atomLabel)
        : [],
      integrity: Array.isArray(label.integrity)
        ? label.integrity.map(atomLabel)
        : [],
      origin: typeof e.origin === "string" ? e.origin : undefined,
    });
  }
  return out;
}

/**
 * A stream / owned cell carries no schema of its own — its DECLARED schema (a
 * stream's event payload, a cell's value type) is attached where it is NAMED in
 * its owner piece, under the key `<key>`. Two sources, link-first:
 *   1. the inline `schema` on the LINK itself (`value[key]."/"."link@N".schema`)
 *      — present even when the result schema omits the handler (e.g. addFavorite),
 *   2. else the owner's `schema.properties[<key>]`, following a `$ref` into `$defs`.
 */
function declaredSchemaFor(
  ownerDoc: EntityDocument | undefined,
  key: string,
): { schema: unknown; keys?: string[]; via: string } | undefined {
  // 1. inline schema carried on the naming link.
  const linkRaw = isObj(ownerDoc?.value)
    ? (ownerDoc!.value as Record<string, unknown>)[key]
    : undefined;
  if (isObj(linkRaw) && isObj(linkRaw["/"])) {
    const slash = linkRaw["/"] as Record<string, unknown>;
    const linkKey = Object.keys(slash).find((k) => k.startsWith("link@"));
    const inner = linkKey ? slash[linkKey] : undefined;
    if (isObj(inner) && isObj(inner.schema)) {
      return {
        schema: annotate(inner.schema),
        keys: Object.keys(inner.schema),
        via: "link",
      };
    }
  }
  // 2. fallback: owner's result-schema property ($ref into $defs).
  const osch = ownerDoc?.schema;
  if (isObj(osch) && isObj(osch.properties)) {
    const prop = osch.properties[key];
    if (isObj(prop)) {
      let resolved: Record<string, unknown> = prop;
      const ref = typeof prop.$ref === "string" ? prop.$ref : undefined;
      if (ref?.startsWith("#/$defs/") && isObj(osch.$defs)) {
        const def = osch.$defs[ref.slice("#/$defs/".length)];
        if (isObj(def)) resolved = def;
      }
      return {
        schema: annotate(resolved),
        keys: Object.keys(resolved),
        via: "schema",
      };
    }
  }
  return undefined;
}

/** Collect every sigil link in a value, with its JSON path. */
function linksWithPaths(
  v: unknown,
  base: string[] = [],
  out: { link: DecodedLink; at: string }[] = [],
  depth = 10,
): { link: DecodedLink; at: string }[] {
  if (depth < 0) return out;
  const link = parseSigilLink(v);
  if (link) {
    out.push({ link, at: base.join("/") });
    return out;
  }
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      linksWithPaths(val, [...base, k], out, depth - 1);
    }
  } else if (Array.isArray(v)) {
    v.forEach((val, i) =>
      linksWithPaths(val, [...base, String(i)], out, depth - 1)
    );
  }
  return out;
}

interface DetailContext {
  ownDid: string;
  labelOf: Map<string, { kind: EntityKind; label: string }>;
  /** entityId → { ownerId, key } naming it in its owner piece's value. */
  nameOf: Map<string, { owner: string; key: string }>;
  moduleIndex: Map<string, ModuleEntry>;
  docs: Map<string, EntityDocument>;
}

function refTo(
  id: string | undefined,
  ctx: DetailContext,
): LinkRef | undefined {
  if (!id) return undefined;
  const info = ctx.labelOf.get(id);
  return { id, label: info?.label, kind: info?.kind };
}

/** Build the rich detail for a single (already reconstructed) document. */
function detailFromDoc(
  id: string,
  doc: EntityDocument,
  ctx: DetailContext,
  versions: VersionRow[],
): EntityDetail {
  const c = classifyDocument(doc);
  const value = doc.value;
  const spec = importSpecifier(value);
  const named = ctx.nameOf.get(id);

  // --- context-aware label + role ----------------------------------------
  // Label comes from the shared index (it already folds in import/context/legacy
  // refinements); role is computed here.
  let label = ctx.labelOf.get(id)?.label ?? c.label;
  let role: string = c.kind;
  if (spec) {
    label = `import ${spec}`;
    role = "module import";
  } else if (named) {
    role = c.kind === "stream"
      ? `stream · ${named.key}`
      : `cell · ${named.key}`;
  } else if (c.kind === "piece" && c.regime === "legacy") {
    role = "piece (legacy process)";
  } else {
    role = roleFor(c.kind, c.owned);
  }

  // --- lineage, resolved to target labels --------------------------------
  const lineage: EntityDetail["lineage"] = {};
  if (c.lineage.argument) {
    lineage.argument = refTo(c.lineage.argument, ctx);
  }
  if (c.lineage.owner) lineage.owner = refTo(c.lineage.owner, ctx);
  // Legacy: surface the result cell + the owned-cell manifest from the value.
  if (c.kind === "piece" && c.regime === "legacy" && isObj(value)) {
    const rid = legacyResultId(value);
    if (rid) lineage.result = refTo(rid, ctx);
    const internalIds = linksWithPaths(value.internal)
      .map((l) => l.link.id).filter((x): x is string => !!x);
    if (internalIds.length) {
      lineage.internal = internalIds.map((cid) => refTo(cid, ctx)!);
    }
  }
  if (c.lineage.internal?.length) {
    lineage.internal = c.lineage.internal.map((cid) => refTo(cid, ctx)!);
  }
  if (c.lineage.pattern) {
    const mid = ctx.moduleIndex.get(c.lineage.pattern.identity);
    const ref: EntityDetail["lineage"]["pattern"] = {
      id: mid?.id ?? c.lineage.pattern.identity,
      label: mid ? ctx.labelOf.get(mid.id)?.label : undefined,
      kind: "module",
      symbol: c.lineage.pattern.symbol,
      filename: mid?.filename,
    };
    if (mid) {
      const mdoc = ctx.docs.get(mid.id);
      const mv = mdoc?.value;
      if (isModuleValue(mv)) ref.codeLines = mv.code.split("\n").length;
    }
    lineage.pattern = ref;
  }

  // --- outgoing links, resolved ------------------------------------------
  const outLinks: LinkRef[] = linksWithPaths(value).map(({ link, at }) => {
    const external = !!link.space && link.space !== ctx.ownDid &&
      link.space !== `did:key:${ctx.ownDid}`;
    return {
      id: link.id ?? "?",
      label: link.id ? ctx.labelOf.get(link.id)?.label : undefined,
      kind: link.id ? ctx.labelOf.get(link.id)?.kind : undefined,
      space: link.space,
      path: link.path ? [...link.path] : undefined,
      external,
      at,
    };
  });

  // --- module source -----------------------------------------------------
  let code: string | undefined;
  if (isModuleValue(value)) code = value.code;

  // --- schema / ifc / cfc ------------------------------------------------
  let schema = doc.schema !== undefined ? annotate(doc.schema) : undefined;
  let schemaKeys = isObj(doc.schema) ? Object.keys(doc.schema) : undefined;
  let schemaSource: string | undefined;
  let streamPayload: boolean | undefined;
  // A stream / named owned cell has no own schema — resolve the DECLARED one
  // from the owner piece that names it.
  if (schema === undefined && named) {
    const decl = declaredSchemaFor(ctx.docs.get(named.owner), named.key);
    if (decl) {
      schema = decl.schema;
      schemaKeys = decl.keys;
      streamPayload = c.kind === "stream";
      schemaSource = decl.via === "link"
        ? `declared at owner · ${named.key} (link)`
        : `declared in owner schema · ${named.key}`;
    }
  }
  const ifc = isObj(value) && "ifc" in value ? annotate(value.ifc) : undefined;
  const cfc = parseCfc(doc.cfc);

  return {
    id,
    kind: c.kind,
    regime: c.regime,
    owned: c.owned,
    label,
    role,
    contextName: named?.key,
    paths: c.paths,
    valueShape: c.valueShape,
    value: annotate(value),
    valuePreview: summarize(value),
    schema,
    schemaKeys,
    schemaSource,
    streamPayload,
    ifc,
    cfc,
    revisions: versions.length,
    headSeq: versions.length ? versions[versions.length - 1].seq : null,
    firstSeq: versions.length ? versions[0].seq : null,
    versions,
    lineage,
    outLinks,
    code,
  };
}

function roleFor(kind: EntityKind, owned: boolean): string {
  switch (kind) {
    case "piece":
      return "piece (running pattern)";
    case "module":
      return "module (pattern source)";
    case "stream":
      return owned ? "owned stream" : "stream";
    case "schema":
      return "schema";
    case "owned-cell":
      return "owned cell";
    case "free-cell":
      return "free cell";
    default:
      return "entity";
  }
}

/**
 * Build rich details for every entity in a space — one reconstruction pass,
 * resolving link-target labels and owner→child context names space-wide.
 */
export function buildAllDetails(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; limit?: number } = {},
): EntityDetail[] {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = opts.limit ?? 5000;
  const ownDid = (space.path.split("/").pop() ?? "").replace(/\.sqlite$/, "");

  const rows = space.db
    .prepare(
      `SELECT id, count(*) revisions FROM revision
       WHERE branch = ? AND scope_key = ?
       GROUP BY id ORDER BY revisions DESC LIMIT ?`,
    )
    .all<{ id: string; revisions: number }>(branch, scope, limit);

  // Pass 1: reconstruct + module index + base labels.
  const docs = new Map<string, EntityDocument>();
  const moduleIndex = new Map<string, ModuleEntry>();
  const labelOf = new Map<string, { kind: EntityKind; label: string }>();
  for (const r of rows) {
    let doc: EntityDocument | undefined;
    try {
      doc = reconstructDocument(space, { id: r.id, branch, scope });
    } catch {
      doc = undefined;
    }
    if (!doc) continue;
    docs.set(r.id, doc);
    const v = doc.value;
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

  // Pass 2: context names (key in a piece's value that points at a child) +
  // base labels (refined by import specifier / context name).
  const nameOf = new Map<string, { owner: string; key: string }>();
  for (const [id, doc] of docs) {
    const c = classifyDocument(doc);
    // Only MODERN piece result values carry semantic names as keys (createProfile,
    // profiles, …). A legacy PROCESS cell's top-level keys are control-plane
    // ($TYPE/resultRef/internal/argument) — naming children by those is noise.
    if (c.kind === "piece" && c.regime === "modern" && isObj(doc.value)) {
      for (const [key, val] of Object.entries(doc.value)) {
        const tid = parseSigilLink(val)?.id;
        if (tid && !nameOf.has(tid)) nameOf.set(tid, { owner: id, key });
      }
    }
  }
  for (const [id, doc] of docs) {
    const c = classifyDocument(doc);
    const spec = importSpecifier(doc.value);
    const named = nameOf.get(id);
    let label = c.label;
    if (spec) label = `import ${spec}`;
    else if (named) label = c.kind === "stream" ? `⊙ ${named.key}` : named.key;
    else if (c.kind === "piece" && c.regime === "legacy") {
      label = legacyName(doc.value, docs) ?? label;
    }
    labelOf.set(id, { kind: c.kind, label });
  }

  const ctx: DetailContext = { ownDid, labelOf, nameOf, moduleIndex, docs };

  // Pass 3: per-entity detail + version log.
  const versionStmt = space.db.prepare(
    `SELECT r.seq, r.op, c.session_id, c.created_at
     FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
     WHERE r.branch = ? AND r.id = ? AND r.scope_key = ?
     ORDER BY r.seq ASC, r.op_index ASC`,
  );
  const out: EntityDetail[] = [];
  for (const [id, doc] of docs) {
    const versions = versionStmt
      .all<{ seq: number; op: string; session_id: string; created_at: string }>(
        branch,
        id,
        scope,
      )
      .map((v) => ({
        seq: v.seq,
        op: v.op,
        session: v.session_id,
        createdAt: v.created_at,
      }));
    out.push(detailFromDoc(id, doc, ctx, versions));
  }

  const order: Record<EntityKind, number> = {
    piece: 0,
    module: 1,
    stream: 2,
    schema: 3,
    "owned-cell": 4,
    "free-cell": 5,
    unknown: 6,
  };
  return out.sort(
    (a, b) => order[a.kind] - order[b.kind] || (b.revisions - a.revisions),
  );
}

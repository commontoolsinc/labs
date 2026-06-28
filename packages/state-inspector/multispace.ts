// Cross-space convergence diagnosis — the multiplayer-native autopsy primitive.
//
// The same entity id can appear in several spaces for TWO very different reasons,
// and telling them apart is the whole game:
//
//  1. Cross-space replica — a link in space A points to `space B / entity X`, so
//     A materializes a replica of B's X. These SHOULD converge; divergence is a
//     real drift bug.
//  2. Same-pattern instance — every space independently instantiates the same
//     pattern (e.g. home.tsx), so its program/result entity shares a content-
//     addressed id across spaces by coincidence of code. These legitimately
//     diverge; same-id divergence here is expected, not a bug.
//
// `convergence()` compares an entity's value across N spaces and clusters it. The
// link index (`buildCrossSpaceLinkIndex`) then classifies each divergence:
// `cross-space-linked` (case 1 — real drift) vs `no-cross-space-link` (case 2 —
// likely independent instances). NOTE: real dev DBs frequently contain ZERO
// cross-space links, in which case every same-id divergence is correctly labeled
// `no-cross-space-link` — the classifier exists to stop false alarms now and to
// catch real drift the moment cross-space replicas appear.
//
// HONESTY (server-view only): this sees durable committed state, not client
// state. A "converged" verdict means the stored values agree — NOT that every
// client is displaying them. Client cursor lag, pending optimistic writes, and
// render/VDOM state require the (future) client-correlation overlay. Likewise
// `seq` is per-space and is NOT comparable across spaces; divergence is judged
// by value equality, with per-space write metadata offered as evidence.

import { openSpace, type SpaceDb } from "./db.ts";
import { annotate, collectLinks } from "./decode.ts";
import { getValueAt, reconstructDocument } from "./reconstruct.ts";

export interface SpaceRef {
  /** Display label — usually the space DID (DB file basename). */
  label: string;
  space: SpaceDb;
}

export interface SpaceEntityView {
  label: string;
  present: boolean;
  headSeq: number | null;
  revisions: number;
  lastSession: string | null;
  lastWriteAt: string | null;
  /** Annotated value at the requested path (links/streams normalized). */
  value?: unknown;
  /** Canonical key used for clustering equal values. */
  valueKey?: string;
  /** Set if reconstruction/decode threw for this space (entity still counts as present). */
  error?: string;
}

export type ConvergenceVerdict =
  | "converged"
  | "diverged"
  | "partial"
  | "absent";

export interface ValueCluster {
  valueKey: string;
  value: unknown;
  labels: string[];
}

export type ConvergenceRelationship =
  | "cross-space-linked" // a space links to this entity@another-space → real replica drift
  | "no-cross-space-link" // shared id, no cross-space link → likely independent instances
  | "n/a"; // converged/absent — relationship not meaningful

export interface ConvergenceResult {
  id: string;
  scope: string;
  branch: string;
  path: string[];
  verdict: ConvergenceVerdict;
  views: SpaceEntityView[];
  clusters: ValueCluster[];
  caveat: string;
  /** Set when a link index is supplied — distinguishes drift from instances. */
  relationship?: ConvergenceRelationship;
}

export interface CrossSpaceEdge {
  fromSpace: string;
  fromEntity: string;
  toSpace: string;
  toId: string;
}

export interface CrossSpaceLinkIndex {
  edges: CrossSpaceEdge[];
  /** `${toSpace} ${toId}` for every entity referenced cross-space. */
  targets: Set<string>;
  examinedEntities: number;
}

/** Recover a space's own DID from its DB-file label (basename minus `.sqlite`). */
export function spaceDidFromLabel(label: string): string {
  return label.endsWith(".sqlite") ? label.slice(0, -".sqlite".length) : label;
}

const CAVEAT =
  "Server-view only: durable values compared. Client cursor lag, pending " +
  "optimistic writes, and render state are not visible here — 'converged' " +
  "means the stored values agree, not that every client is displaying them.";

/** Stable, key-sorted JSON so clustering ignores object key order. */
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = sort(o[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(sort(v)) ?? "undefined";
}

interface MetaRow {
  headSeq: number | null;
  revisions: number;
}
interface LastRow {
  session_id: string;
  created_at: string;
}

function entityMeta(
  space: SpaceDb,
  id: string,
  scope: string,
  branch: string,
): SpaceEntityView {
  const meta = space.db
    .prepare(
      `SELECT max(seq) headSeq, count(*) revisions FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ?`,
    )
    .get<MetaRow>(branch, id, scope);
  const present = !!meta && meta.revisions > 0;
  if (!present) {
    return {
      label: "",
      present: false,
      headSeq: null,
      revisions: 0,
      lastSession: null,
      lastWriteAt: null,
    };
  }
  const last = space.db
    .prepare(
      `SELECT c.session_id, c.created_at FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ?
       ORDER BY r.seq DESC, r.op_index DESC LIMIT 1`,
    )
    .get<LastRow>(branch, id, scope);
  return {
    label: "",
    present: true,
    headSeq: meta!.headSeq,
    revisions: meta!.revisions,
    lastSession: last?.session_id ?? null,
    lastWriteAt: last?.created_at ?? null,
  };
}

export interface ConvergenceOptions {
  id: string;
  scope?: string;
  branch?: string;
  path?: string[];
}

/** Compare one entity's value across the given spaces and classify. */
export function convergence(
  spaces: SpaceRef[],
  opts: ConvergenceOptions,
  index?: CrossSpaceLinkIndex,
): ConvergenceResult {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const path = opts.path ?? [];

  const views: SpaceEntityView[] = spaces.map(({ label, space }) => {
    const view = entityMeta(space, opts.id, scope, branch);
    view.label = label;
    if (view.present) {
      // Decode can throw (e.g. an fvj1 payload referencing a live cell). Keep the
      // entity counted as present but isolate the failure so one bad row doesn't
      // abort a whole scan; errored spaces cluster together by a distinct key.
      try {
        const res = getValueAt(space, { id: opts.id, scope, branch }, path);
        view.value = annotate(res.value);
        view.valueKey = canonical(view.value);
      } catch (e) {
        view.error = (e as Error).message;
        view.valueKey = "«decode-error»";
      }
    }
    return view;
  });

  const present = views.filter((v) => v.present);
  const clusterMap = new Map<string, ValueCluster>();
  for (const v of present) {
    const key = v.valueKey!;
    const c = clusterMap.get(key);
    if (c) c.labels.push(v.label);
    else {clusterMap.set(key, {
        valueKey: key,
        value: v.value,
        labels: [v.label],
      });}
  }
  const clusters = [...clusterMap.values()];

  let verdict: ConvergenceVerdict;
  if (present.length === 0) verdict = "absent";
  else if (clusters.length > 1) verdict = "diverged";
  else if (present.length < views.length) verdict = "partial";
  else verdict = "converged";

  const result: ConvergenceResult = {
    id: opts.id,
    scope,
    branch,
    path,
    verdict,
    views,
    clusters,
    caveat: CAVEAT,
  };
  if (index) result.relationship = classifyRelationship(result, index);
  return result;
}

/**
 * Build a cross-space link index over the given spaces: every link whose `space`
 * field names a DIFFERENT space than the one holding it. Only entities whose
 * stored data carries an explicit `"space":"did:key:` are reconstructed, which
 * keeps the index cheap (most links omit `space` = same-space and can't be
 * cross-space). Decode failures on individual entities are skipped, not fatal.
 */
export function buildCrossSpaceLinkIndex(
  spaces: SpaceRef[],
  opts: { scope?: string; branch?: string } = {},
): CrossSpaceLinkIndex {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const edges: CrossSpaceEdge[] = [];
  const targets = new Set<string>();
  let examinedEntities = 0;

  for (const { label, space } of spaces) {
    const ownDid = spaceDidFromLabel(label);
    const candidates = space.db
      .prepare(
        `SELECT DISTINCT id FROM revision
         WHERE branch = ? AND scope_key = ? AND data LIKE '%"space":"did:key:%'`,
      )
      .all<{ id: string }>(branch, scope);
    for (const { id } of candidates) {
      examinedEntities++;
      let doc: unknown;
      try {
        doc = reconstructDocument(space, { id, scope, branch });
      } catch {
        continue;
      }
      for (const link of collectLinks(doc)) {
        if (link.id && link.space && link.space !== ownDid) {
          edges.push({
            fromSpace: ownDid,
            fromEntity: id,
            toSpace: link.space,
            toId: link.id,
          });
          targets.add(`${link.space} ${link.id}`);
        }
      }
    }
  }
  return { edges, targets, examinedEntities };
}

/** Label a divergence as real replica drift vs. likely independent instances. */
export function classifyRelationship(
  result: ConvergenceResult,
  index: CrossSpaceLinkIndex,
): ConvergenceRelationship {
  if (result.verdict === "converged" || result.verdict === "absent") {
    return "n/a";
  }
  const linked = result.views.some(
    (v) =>
      v.present &&
      index.targets.has(`${spaceDidFromLabel(v.label)} ${result.id}`),
  );
  return linked ? "cross-space-linked" : "no-cross-space-link";
}

export interface ScanOptions {
  scope?: string;
  branch?: string;
  /** Max diverged/partial findings to return. */
  limit?: number;
  /** Max shared entities to reconstruct (cost guard). */
  examineCap?: number;
  /** Build the cross-space link index to classify findings (default true). */
  linkIndex?: boolean;
}

export interface ScanResult {
  /** Entity ids present in >= 2 spaces. */
  sharedEntities: number;
  examined: number;
  examineCapped: boolean;
  /** Cross-space link edges found across all spaces (0 ⇒ no replica relationships). */
  crossSpaceLinkEdges: number;
  /** Findings labeled cross-space-linked (real replica drift). */
  linkedFindings: number;
  /** Findings labeled no-cross-space-link (likely independent instances). */
  unlinkedFindings: number;
  findings: ConvergenceResult[];
}

/** Find entities present in >=2 spaces and report those that diverge. */
export function convergenceScan(
  spaces: SpaceRef[],
  opts: ScanOptions = {},
): ScanResult {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 50;
  const examineCap = opts.examineCap ?? 1000;

  const index = opts.linkIndex === false
    ? undefined
    : buildCrossSpaceLinkIndex(spaces, { scope, branch });

  // id -> how many spaces hold it
  const counts = new Map<string, number>();
  for (const { space } of spaces) {
    const ids = space.db
      .prepare(
        `SELECT DISTINCT id FROM revision WHERE branch = ? AND scope_key = ?`,
      )
      .all<{ id: string }>(branch, scope);
    for (const { id } of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const shared = [...counts.entries()].filter(([, n]) => n >= 2).map(([id]) =>
    id
  );

  const findings: ConvergenceResult[] = [];
  let examined = 0;
  for (const id of shared) {
    if (examined >= examineCap) break;
    examined++;
    const result = convergence(spaces, { id, scope, branch }, index);
    if (result.verdict === "diverged" || result.verdict === "partial") {
      findings.push(result);
      if (findings.length >= limit) break;
    }
  }

  const linkedFindings =
    findings.filter((f) => f.relationship === "cross-space-linked").length;
  return {
    sharedEntities: shared.length,
    examined,
    examineCapped: examined >= examineCap && shared.length > examineCap,
    crossSpaceLinkEdges: index?.edges.length ?? 0,
    linkedFindings,
    unlinkedFindings: findings.length - linkedFindings,
    findings,
  };
}

/** Open spaces from explicit file paths, labeling each by its basename. */
export function openSpaces(paths: string[]): SpaceRef[] {
  return paths.map((p) => ({
    label: p.split("/").pop() ?? p,
    space: openSpace(p),
  }));
}

/** List `*.sqlite` files in a directory (non-recursive). */
export function listSqliteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isFile && entry.name.endsWith(".sqlite")) {
      out.push(`${dir}/${entry.name}`);
    }
  }
  return out.sort();
}

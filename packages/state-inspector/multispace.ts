// Cross-space convergence diagnosis — the multiplayer-native autopsy primitive.
//
// The same logical entity (same id) is often materialized into several spaces:
// a cross-space link from space A to `space B / entity X` makes A hold a replica
// of X. When two clients/identities disagree about a value, the durable cause is
// frequently that these replicas have diverged. This module compares an entity's
// reconstructed value across N space DBs and classifies the result.
//
// HONESTY (server-view only): this sees durable committed state, not client
// state. A "converged" verdict means the stored values agree — NOT that every
// client is displaying them. Client cursor lag, pending optimistic writes, and
// render/VDOM state require the (future) client-correlation overlay. Likewise
// `seq` is per-space and is NOT comparable across spaces; divergence is judged
// by value equality, with per-space write metadata offered as evidence.

import { openSpace, type SpaceDb } from "./db.ts";
import { annotate } from "./decode.ts";
import { getValueAt } from "./reconstruct.ts";

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

export interface ConvergenceResult {
  id: string;
  scope: string;
  branch: string;
  path: string[];
  verdict: ConvergenceVerdict;
  views: SpaceEntityView[];
  clusters: ValueCluster[];
  caveat: string;
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
    else clusterMap.set(key, { valueKey: key, value: v.value, labels: [v.label] });
  }
  const clusters = [...clusterMap.values()];

  let verdict: ConvergenceVerdict;
  if (present.length === 0) verdict = "absent";
  else if (clusters.length > 1) verdict = "diverged";
  else if (present.length < views.length) verdict = "partial";
  else verdict = "converged";

  return { id: opts.id, scope, branch, path, verdict, views, clusters, caveat: CAVEAT };
}

export interface ScanOptions {
  scope?: string;
  branch?: string;
  /** Max diverged/partial findings to return. */
  limit?: number;
  /** Max shared entities to reconstruct (cost guard). */
  examineCap?: number;
}

export interface ScanResult {
  /** Entity ids present in >= 2 spaces. */
  sharedEntities: number;
  examined: number;
  examineCapped: boolean;
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
  const shared = [...counts.entries()].filter(([, n]) => n >= 2).map(([id]) => id);

  const findings: ConvergenceResult[] = [];
  let examined = 0;
  for (const id of shared) {
    if (examined >= examineCap) break;
    examined++;
    const result = convergence(spaces, { id, scope, branch });
    if (result.verdict === "diverged" || result.verdict === "partial") {
      findings.push(result);
      if (findings.length >= limit) break;
    }
  }

  return {
    sharedEntities: shared.length,
    examined,
    examineCapped: examined >= examineCap && shared.length > examineCap,
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
    if (entry.isFile && entry.name.endsWith(".sqlite")) out.push(`${dir}/${entry.name}`);
  }
  return out.sort();
}

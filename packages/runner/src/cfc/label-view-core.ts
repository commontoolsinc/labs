import { encodePointer } from "../../../memory/v2/path.ts";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { uniqueCfcAtoms } from "./observation.ts";
import { normalizeClause } from "./clause.ts";

export type IFCLabel = {
  confidentiality?: unknown[];
  integrity?: unknown[];
};

/**
 * Consumption class of a label entry (Epic C, spec §4.6.3;
 * docs/specs/cfc-observation-classes.md §3-§4). Defined here — the leaf of
 * the cfc module graph — and re-exported through `types.ts`, which imports
 * this module.
 */
export type LabelObservationClass =
  | "value"
  | "shape"
  | "enumerate"
  | "followRef";

export type CfcLabelViewEntry = {
  path: readonly string[];
  label: IFCLabel;
  /**
   * EFFECTIVE consumption class (C4): unlike the persisted
   * `LabelMapEntry.observes`, view entries resolve the implicit
   * `origin:"link"` ⇒ `followRef` carve-out at build time
   * (`cfcLabelViewFromMetadata`), so view consumers never see `origin`.
   * Absent = covering for the content classes.
   */
  observes?: LabelObservationClass;
};

export type CfcLabelView = {
  version: 1;
  entries: CfcLabelViewEntry[];
};

const LABEL_KEYS = [
  "confidentiality",
  "integrity",
] as const satisfies readonly (keyof IFCLabel)[];

export const canonicalizeCfcLogicalPath = (
  path: readonly string[],
): string[] => path[0] === "value" ? [...path.slice(1)] : [...path];

export const cfcLabelViewPathKey = (path: readonly string[]): string =>
  encodePointer(canonicalizeCfcLogicalPath(path));

export const cfcLabelPathPrefixMatches = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

export const cfcLabelPathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  cfcLabelPathPrefixMatches(left, right) ||
  cfcLabelPathPrefixMatches(right, left);

export const cloneCfcLabel = (label: IFCLabel): IFCLabel => {
  const cloned: IFCLabel = {};
  for (const key of LABEL_KEYS) {
    const value = label[key];
    if (Array.isArray(value) && value.length > 0) {
      cloned[key] = [...value];
    }
  }
  return cloned;
};

export const hasCfcLabelValues = (label: IFCLabel): boolean =>
  LABEL_KEYS.some((key) => Array.isArray(label[key]) && label[key]!.length > 0);

// Recursively strip `Caveat.source` — the principal identity that introduced a
// caveat — from an atom and every atom nested inside it. CFC atoms nest (e.g.
// `PromptSlotBound.source` / `Caveat.by` are themselves `CfcAtom`s), so a Caveat
// can appear at any depth; walk the whole structure and drop `source` from each
// Caveat found, leaving its `kind`/`by`/`type` and all other atoms intact.
const redactCaveatSourceAtom = (atom: unknown): unknown => {
  if (Array.isArray(atom)) {
    return atom.map(redactCaveatSourceAtom);
  }
  if (atom === null || typeof atom !== "object") {
    return atom;
  }
  const obj = atom as Record<string, unknown>;
  const dropSource = obj.type === CFC_ATOM_TYPE.Caveat;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (dropSource && key === "source") {
      continue;
    }
    out[key] = redactCaveatSourceAtom(value);
  }
  return out;
};

/**
 * Redact `Caveat.source` identities from a label view for the pattern-facing
 * INTROSPECTION surface (`getCfcLabel()` → `handleCellGetCfcLabel`). Surfacing
 * the source lets a pattern learn which principal a caveat came from — an
 * information-flow leak (audit item 28b, inv-12; full inv-12 labeling stays
 * phased).
 *
 * Apply ONLY at main-thread-facing DISPLAY responses: the three IPC label
 * responses (`handleCellGet` includeCfcLabel, the subscribe sink,
 * `handleCellGetCfcLabel`), the sigil `cfcLabelView` copies inside response
 * values (`redactSigilCfcLabelViewsForDisplay`), and response cell refs
 * (`createCellRef`) — inv-12 Stage 0. Redacting every outbound copy is safe
 * because the worker no longer consumes inbound views: the persist seam
 * re-derives link-origin labels from stored source metadata, and the IPC
 * ingress (`cellRefToSigilLink` / `getCell`) drops ref-carried views. It is
 * deliberately NOT used by `cloneCfcLabel`, `cfcLabelViewFromMetadata`, or
 * `cfcLabelViewForCell` — those feed observation labeling
 * (`cfcConfidentialityForObservationNode`), the dereference-trace path
 * `prepare.ts` consumes, and the worker-internal carried-label views, all of
 * which must keep `source` intact for enforcement.
 */
export const redactCaveatSourcesForDisplay = (
  view: CfcLabelView,
): CfcLabelView => ({
  version: 1,
  entries: view.entries.map((entry) => {
    const label: IFCLabel = {};
    for (const key of LABEL_KEYS) {
      const value = entry.label[key];
      if (Array.isArray(value) && value.length > 0) {
        label[key] = value.map(redactCaveatSourceAtom);
      }
    }
    return {
      path: entry.path,
      label,
      ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
    };
  }),
});

const sortEntries = (entries: CfcLabelViewEntry[]): CfcLabelViewEntry[] =>
  entries.sort((left, right) => {
    const leftKey = cfcLabelViewPathKey(left.path);
    const rightKey = cfcLabelViewPathKey(right.path);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

export const mergeLabel = (
  left: IFCLabel | undefined,
  right: IFCLabel,
): IFCLabel => {
  const merged: IFCLabel = {};
  for (const key of LABEL_KEYS) {
    const values = [
      ...(Array.isArray(left?.[key]) ? left[key] : []),
      ...(Array.isArray(right[key]) ? right[key] : []),
    ];
    // Confidentiality is CNF clauses (Epic A3): the join is clause
    // CONCATENATION — `[[A∨B]] ⊔ [C] = [[A∨B], C]` — the OR stays clause-local
    // and `C` remains an independent gate. Normalizing each clause on ingest
    // (dedup + canonical alternative order + singleton unwrap) makes two
    // equivalent OR-clauses that differ only in alternative order coalesce
    // through the structural dedup below. It MUST NOT merge distinct clauses
    // or union their alternative sets — `normalizeClause` only rewrites a
    // clause's own interior, so concatenation + clause-granular dedup upholds
    // the §3.1.8 normalization prohibitions. Integrity carries no OR-clauses,
    // and `normalizeClause` is identity on non-clause atoms, so it is applied
    // only to confidentiality to keep intent explicit.
    const normalized = key === "confidentiality"
      ? values.map(normalizeClause)
      : values;
    // Dedup structurally via `uniqueCfcAtoms()` rather than by reference
    // (`new Set()`). Atoms can be fabric-converted clones (each call to
    // `cloneIfNecessary()` produces a fresh frozen object), so two
    // logically-identical caveats may not share a JS reference. The
    // reference-keyed approach would leave duplicates that callers
    // observe as both `confidentiality` bloat and -- since downstream
    // entry-merging compares labels structurally -- as label entries
    // failing to coalesce at the right path.
    const unique = uniqueCfcAtoms(normalized);
    if (unique.length > 0) {
      merged[key] = unique;
    }
  }
  return merged;
};

export const cloneCfcLabelView = (
  view: CfcLabelView | undefined,
): CfcLabelView | undefined => {
  if (view === undefined) {
    return undefined;
  }
  const entries = sortEntries(
    view.entries.map((entry) => ({
      path: canonicalizeCfcLogicalPath(entry.path),
      label: cloneCfcLabel(entry.label),
      ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
    })).filter((entry) => hasCfcLabelValues(entry.label)),
  );
  return entries.length > 0 ? { version: 1, entries } : undefined;
};

export const mergeCfcLabelViews = (
  views: Array<CfcLabelView | undefined>,
): CfcLabelView | undefined => {
  // Keyed per (class, path): entries of different observation classes stay
  // separate so class-aware consumers (C4) keep their precision; merging a
  // `shape` entry into a covering one would re-smear the container-shape
  // label onto every value read below it.
  const byKey = new Map<string, CfcLabelViewEntry>();
  for (const view of views) {
    if (!view) {
      continue;
    }
    for (const entry of view.entries) {
      const path = canonicalizeCfcLogicalPath(entry.path);
      const key = `${entry.observes ?? ""}\u0000${cfcLabelViewPathKey(path)}`;
      const existing = byKey.get(key);
      byKey.set(key, {
        path,
        label: mergeLabel(existing?.label, entry.label),
        ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
      });
    }
  }
  const entries = sortEntries(
    [...byKey.values()].filter((entry) => hasCfcLabelValues(entry.label)),
  );
  return entries.length > 0 ? { version: 1, entries } : undefined;
};

export const rebaseCfcLabelView = (
  view: CfcLabelView | undefined,
  path: readonly string[],
): CfcLabelView | undefined => {
  if (!view) {
    return undefined;
  }

  const logicalPath = canonicalizeCfcLogicalPath(path);
  const entries: CfcLabelViewEntry[] = [];
  for (const entry of view.entries) {
    const entryPath = canonicalizeCfcLogicalPath(entry.path);
    if (cfcLabelPathPrefixMatches(logicalPath, entryPath)) {
      const label = cloneCfcLabel(entry.label);
      if (hasCfcLabelValues(label)) {
        entries.push({
          path: entryPath.slice(logicalPath.length),
          label,
          ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
        });
      }
    } else if (cfcLabelPathPrefixMatches(entryPath, logicalPath)) {
      // A STRICT ancestor collapsing into the sliced view: content labels
      // (covering / `value`) inherit down — the slice is part of the
      // ancestor's content. Node-anchored channels do not: an ancestor's
      // `shape`/`enumerate` labels membership/existence of the ANCESTOR
      // (the C4 precision win — a public child under a secret container
      // shape does not inherit it), and an ancestor `followRef` labels a
      // pointer the slice is not.
      if (
        entry.observes !== undefined && entry.observes !== "value"
      ) {
        continue;
      }
      const label = cloneCfcLabel(entry.label);
      if (hasCfcLabelValues(label)) {
        entries.push({
          path: [],
          label,
          ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
        });
      }
    }
  }

  return mergeCfcLabelViews([
    entries.length > 0 ? { version: 1, entries } : undefined,
  ]);
};

export const cfcLabelViewsEqual = (
  left: CfcLabelView | undefined,
  right: CfcLabelView | undefined,
): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(cloneCfcLabelView(left)) ===
    JSON.stringify(cloneCfcLabelView(right));
};

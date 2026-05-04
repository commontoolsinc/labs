import { encodePointer } from "../../../memory/v2/path.ts";

export type IFCLabel = {
  confidentiality?: unknown[];
  integrity?: unknown[];
};

export type CfcLabelViewEntry = {
  path: readonly string[];
  label: IFCLabel;
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

const sortEntries = (entries: CfcLabelViewEntry[]): CfcLabelViewEntry[] =>
  entries.sort((left, right) => {
    const leftKey = cfcLabelViewPathKey(left.path);
    const rightKey = cfcLabelViewPathKey(right.path);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

const mergeLabel = (
  left: IFCLabel | undefined,
  right: IFCLabel,
): IFCLabel => {
  const merged: IFCLabel = {};
  for (const key of LABEL_KEYS) {
    const values = [
      ...(Array.isArray(left?.[key]) ? left[key] : []),
      ...(Array.isArray(right[key]) ? right[key] : []),
    ];
    const unique = [...new Set(values)];
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
    })).filter((entry) => hasCfcLabelValues(entry.label)),
  );
  return entries.length > 0 ? { version: 1, entries } : undefined;
};

export const mergeCfcLabelViews = (
  views: Array<CfcLabelView | undefined>,
): CfcLabelView | undefined => {
  const byPath = new Map<string, CfcLabelViewEntry>();
  for (const view of views) {
    if (!view) {
      continue;
    }
    for (const entry of view.entries) {
      const path = canonicalizeCfcLogicalPath(entry.path);
      const key = cfcLabelViewPathKey(path);
      const existing = byPath.get(key);
      byPath.set(key, {
        path,
        label: mergeLabel(existing?.label, entry.label),
      });
    }
  }
  const entries = sortEntries(
    [...byPath.values()].filter((entry) => hasCfcLabelValues(entry.label)),
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
        });
      }
    } else if (cfcLabelPathPrefixMatches(entryPath, logicalPath)) {
      const label = cloneCfcLabel(entry.label);
      if (hasCfcLabelValues(label)) {
        entries.push({ path: [], label });
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

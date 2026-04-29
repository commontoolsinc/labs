import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { canonicalizeLogicalPath, logicalPathToPointer } from "./canonical.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import type {
  CfcAddress,
  CfcDereferenceTrace,
  CfcMetadata,
  IFCLabel,
} from "./types.ts";

export type CfcLabelViewEntry = {
  path: string[];
  label: IFCLabel;
};

export type CfcLabelView = {
  version: 1;
  entries: CfcLabelViewEntry[];
};

export const cfcLabelViewSymbol: unique symbol = Symbol("cfcLabelView");

type CfcLabelCarrier = {
  [cfcLabelViewSymbol]?(): CfcLabelView | undefined;
};

const LABEL_KEYS = [
  "confidentiality",
  "integrity",
] as const satisfies readonly (keyof IFCLabel)[];

const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

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
  entries.sort((left, right) =>
    logicalPathToPointer(left.path).localeCompare(
      logicalPathToPointer(right.path),
    )
  );

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
      path: canonicalizeLogicalPath(entry.path),
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
      const path = canonicalizeLogicalPath(entry.path);
      const key = logicalPathToPointer(path);
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

  const logicalPath = canonicalizeLogicalPath(path);
  const entries: CfcLabelViewEntry[] = [];
  for (const entry of view.entries) {
    const entryPath = canonicalizeLogicalPath(entry.path);
    if (isPrefix(logicalPath, entryPath)) {
      const label = cloneCfcLabel(entry.label);
      if (hasCfcLabelValues(label)) {
        entries.push({
          path: entryPath.slice(logicalPath.length),
          label,
        });
      }
    } else if (isPrefix(entryPath, logicalPath)) {
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

export const cfcLabelViewFromMetadata = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
): CfcLabelView | undefined => {
  if (!metadata) {
    return undefined;
  }

  return rebaseCfcLabelView(
    {
      version: 1,
      entries: metadata.labelMap.entries.map((entry) => ({
        path: entry.path,
        label: entry.label,
      })),
    },
    path,
  );
};

const cfcLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcLabelView | undefined => {
  try {
    return cfcLabelViewFromMetadata(
      readStoredCfcMetadata(tx, address),
      canonicalizeLogicalPath(address.path),
    );
  } catch {
    return undefined;
  }
};

export const cfcLabelViewForDereference = (
  tx: IExtendedStorageTransaction,
  source: CfcAddress,
  target: CfcAddress,
): CfcLabelView | undefined =>
  mergeCfcLabelViews([
    cfcLabelViewForAddress(tx, source),
    cfcLabelViewForAddress(tx, target),
  ]);

export const cfcLabelViewForDereferenceTraces = (
  tx: IExtendedStorageTransaction,
  traces: readonly CfcDereferenceTrace[],
): CfcLabelView | undefined =>
  mergeCfcLabelViews(
    traces.map((trace) =>
      cfcLabelViewForDereference(tx, trace.source, trace.target)
    ),
  );

export const getCarriedCfcLabelView = (
  value: unknown,
): CfcLabelView | undefined => {
  const carrier = value as Partial<CfcLabelCarrier> | undefined;
  if (typeof carrier?.[cfcLabelViewSymbol] !== "function") {
    return undefined;
  }
  return cloneCfcLabelView(carrier[cfcLabelViewSymbol]());
};

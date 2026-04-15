import { isRecord } from "@commonfabric/utils/types";
import type {
  IExtendedStorageTransaction,
  MediaType,
} from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import { canonicalizeLogicalPath, logicalPathToPointer } from "./canonical.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import type { CfcMetadata, IFCLabel } from "./types.ts";
import { isInternalVerifierRead } from "../storage/reactivity-log.ts";

export type CfcLabelViewEntry = {
  path: string[];
  label: IFCLabel;
};

export type CfcLabelView = {
  version: 1;
  entries: CfcLabelViewEntry[];
};

type LabelQueryableCell = {
  getAsNormalizedFullLink(): NormalizedFullLink;
  get?(options?: { traverseCells?: boolean }): unknown;
  getSourceCell?(): LabelQueryableCell | undefined;
  withTx?(tx: IExtendedStorageTransaction): LabelQueryableCell;
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
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

const cloneLabel = (label: IFCLabel): IFCLabel => {
  const cloned: IFCLabel = {};
  for (const key of LABEL_KEYS) {
    const value = label[key];
    if (Array.isArray(value) && value.length > 0) {
      cloned[key] = [...value];
    }
  }
  return cloned;
};

const hasLabelValues = (label: IFCLabel): boolean =>
  LABEL_KEYS.some((key) => Array.isArray(label[key]) && label[key]!.length > 0);

const sortEntries = (entries: CfcLabelViewEntry[]): CfcLabelViewEntry[] =>
  entries.sort((left, right) =>
    logicalPathToPointer(left.path).localeCompare(
      logicalPathToPointer(right.path),
    )
  );

export const cfcLabelViewFromMetadata = (
  metadata: CfcMetadata | undefined,
  path: readonly string[],
): CfcLabelView | undefined => {
  if (!metadata) {
    return undefined;
  }

  const logicalPath = canonicalizeLogicalPath(path);
  const entries: CfcLabelViewEntry[] = [];
  for (const entry of metadata.labelMap.entries) {
    const entryPath = canonicalizeLogicalPath(entry.path);
    if (isPrefix(logicalPath, entryPath)) {
      const label = cloneLabel(entry.label);
      if (hasLabelValues(label)) {
        entries.push({
          path: entryPath.slice(logicalPath.length),
          label,
        });
      }
    } else if (isPrefix(entryPath, logicalPath)) {
      const label = cloneLabel(entry.label);
      if (hasLabelValues(label)) {
        entries.push({ path: [], label });
      }
    }
  }

  return entries.length > 0
    ? { version: 1, entries: sortEntries(entries) }
    : undefined;
};

const storedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): CfcMetadata | undefined => {
  if (!cell.runtime) {
    return undefined;
  }
  try {
    return readStoredCfcMetadata(
      cell.runtime.readTx(cell.tx),
      {
        space: link.space,
        id: link.id,
        type: link.type as MediaType,
      },
    );
  } catch {
    return undefined;
  }
};

const mergeLabel = (left: IFCLabel | undefined, right: IFCLabel): IFCLabel => {
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

const mergeViews = (
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
    [...byPath.values()].filter((entry) => hasLabelValues(entry.label)),
  );
  return entries.length > 0 ? { version: 1, entries } : undefined;
};

const readLabelViewForCell = (
  cell: LabelQueryableCell,
): CfcLabelView | undefined => {
  if (!cell.runtime || typeof cell.withTx !== "function") {
    return undefined;
  }

  const tx = cell.runtime.readTx();
  try {
    const readCell = cell.withTx(tx);
    if (typeof readCell.get === "function") {
      readCell.get({ traverseCells: true });
    } else {
      const link = readCell.getAsNormalizedFullLink();
      tx.readValueOrThrow(link);
    }
  } catch {
    return undefined;
  }

  const reads = [...(tx.getReadActivities?.() ?? [])];
  const views = reads.flatMap((read) => {
    if (isInternalVerifierRead(read.meta)) {
      return [];
    }
    return cfcLabelViewFromMetadata(
      readStoredCfcMetadata(tx, read),
      canonicalizeLogicalPath(read.path),
    );
  });
  return mergeViews(views);
};

export const cfcLabelViewForCell = (
  cell: unknown,
): CfcLabelView | undefined => {
  if (
    !isRecord(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    return undefined;
  }

  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    return undefined;
  }

  const metadataView = cfcLabelViewFromMetadata(
    storedMetadataForCell(cell as LabelQueryableCell, link),
    link.path,
  );
  if (metadataView !== undefined) {
    return metadataView;
  }

  const sourceCell = (cell as LabelQueryableCell).getSourceCell?.();
  if (sourceCell !== undefined) {
    const sourceLink = sourceCell.getAsNormalizedFullLink();
    const sourceMetadataView = cfcLabelViewFromMetadata(
      storedMetadataForCell(sourceCell, sourceLink),
      link.path,
    );
    if (sourceMetadataView !== undefined) {
      return sourceMetadataView;
    }
  }

  return readLabelViewForCell(cell as LabelQueryableCell);
};

import { isRecord } from "@commonfabric/utils/types";
import type { JSONSchema } from "../builder/types.ts";
import type {
  IExtendedStorageTransaction,
  MediaType,
} from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import { canonicalizeLogicalPath, logicalPathToPointer } from "./canonical.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import type { CfcMetadata, IFCLabel } from "./types.ts";

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
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
};

const LABEL_KEYS = [
  "classification",
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

const labelFromIfc = (ifc: unknown): IFCLabel | undefined => {
  if (!isRecord(ifc)) {
    return undefined;
  }
  const label: IFCLabel = {};
  if (Array.isArray(ifc.classification) && ifc.classification.length > 0) {
    label.classification = [...ifc.classification];
  }
  if (
    Array.isArray(ifc.maxConfidentiality) &&
    ifc.maxConfidentiality.length > 0
  ) {
    label.confidentiality = [...ifc.maxConfidentiality];
  }
  if (Array.isArray(ifc.integrity) && ifc.integrity.length > 0) {
    label.integrity = [...ifc.integrity];
  }
  return hasLabelValues(label) ? label : undefined;
};

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

const walkIfcSchema = (
  schema: JSONSchema | undefined,
  path: string[] = [],
  entries: CfcLabelViewEntry[] = [],
): CfcLabelViewEntry[] => {
  if (!schema || typeof schema === "boolean") {
    return entries;
  }

  const label = labelFromIfc(schema.ifc);
  if (label) {
    entries.push({ path, label });
  }

  if (isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      walkIfcSchema(child as JSONSchema, [...path, key], entries);
    }
  }
  if (typeof schema.items === "object" && schema.items !== null) {
    walkIfcSchema(schema.items as JSONSchema, [...path, "*"], entries);
  }
  return entries;
};

export const cfcLabelViewFromSchema = (
  schema: JSONSchema | undefined,
): CfcLabelView | undefined => {
  const entries = sortEntries(walkIfcSchema(schema));
  return entries.length > 0 ? { version: 1, entries } : undefined;
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
  return cfcLabelViewFromSchema(link.schema);
};

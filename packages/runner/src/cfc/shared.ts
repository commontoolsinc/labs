import type { IMemorySpaceAddress, Labels } from "../storage/interface.ts";
import {
  joinConfidentialityLabels,
  joinIntegrityLabels,
  normalizeConfidentialityLabel,
  normalizeIntegrityLabel,
} from "./label-algebra.ts";
import type { ReadObservationOp } from "./read-observation.ts";

type CfcEntityKeyAddress = {
  space: string;
  id: string;
  type: string;
};
type CfcEntityAddress = Pick<IMemorySpaceAddress, "space" | "id" | "type">;

export interface PathLabelIterateTemplate {
  readonly order?: Labels;
  readonly count?: Labels;
}

export interface PathLabelTemplate {
  readonly label?: Labels;
  readonly shape?: Labels;
  readonly value?: Labels;
  readonly iterate?: PathLabelIterateTemplate;
  readonly children?: PathLabelTemplate;
  readonly views?: Record<string, PathLabelTemplate>;
}

export type PathLabelEntry = Labels | PathLabelTemplate;
export type PersistedPathLabels = Record<string, PathLabelTemplate>;

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function activityWriteChangedFlag(activityWrite: unknown): boolean {
  if (
    activityWrite && typeof activityWrite === "object" &&
    "changed" in activityWrite
  ) {
    return Boolean((activityWrite as { changed?: unknown }).changed);
  }
  return true;
}

export function cfcEntityKey(address: CfcEntityKeyAddress): string {
  return `${address.space}\u0000${address.id}\u0000${address.type}`;
}

export function cfcLabelsAddress(
  address: CfcEntityAddress,
): IMemorySpaceAddress {
  return {
    space: address.space,
    id: address.id,
    type: address.type,
    path: ["cfc", "labels"],
  };
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLeafLabels(value: unknown): Labels | undefined {
  if (!isObjectLike(value)) {
    return undefined;
  }
  const classification = normalizeConfidentialityLabel(value.classification);
  const integrity = normalizeIntegrityLabel(value.integrity);
  if (!classification && !integrity) {
    return undefined;
  }
  return {
    ...(classification ? { classification } : {}),
    ...(integrity ? { integrity } : {}),
  };
}

function normalizePathLabelTemplate(
  value: unknown,
): PathLabelTemplate | undefined {
  const directLeaf = normalizeLeafLabels(value);
  if (!isObjectLike(value)) {
    return directLeaf ? { label: directLeaf } : undefined;
  }

  const label = normalizeLeafLabels(value.label) ?? directLeaf;
  const shape = normalizeLeafLabels(value.shape);
  const fieldValue = normalizeLeafLabels(value.value);

  let iterate: PathLabelIterateTemplate | undefined;
  if (isObjectLike(value.iterate)) {
    const order = normalizeLeafLabels(value.iterate.order);
    const count = normalizeLeafLabels(value.iterate.count);
    if (order || count) {
      iterate = {
        ...(order ? { order } : {}),
        ...(count ? { count } : {}),
      };
    }
  }

  const children = normalizePathLabelTemplate(value.children);

  let views: Record<string, PathLabelTemplate> | undefined;
  if (isObjectLike(value.views)) {
    for (const [name, rawView] of Object.entries(value.views)) {
      const normalizedView = normalizePathLabelTemplate(rawView);
      if (!normalizedView) {
        continue;
      }
      views ??= {};
      views[name] = normalizedView;
    }
  }

  if (!label && !shape && !fieldValue && !iterate && !children && !views) {
    return undefined;
  }

  return {
    ...(label ? { label } : {}),
    ...(shape ? { shape } : {}),
    ...(fieldValue ? { value: fieldValue } : {}),
    ...(iterate ? { iterate } : {}),
    ...(children ? { children } : {}),
    ...(views ? { views } : {}),
  };
}

export function normalizePersistedPathLabels(
  value: unknown,
): PersistedPathLabels {
  if (!isObjectLike(value)) {
    return {};
  }

  const labelsByPath: PersistedPathLabels = {};
  for (const [path, rawLabel] of Object.entries(value)) {
    if (!path.startsWith("/")) {
      continue;
    }
    const normalized = normalizePathLabelTemplate(rawLabel);
    if (!normalized) {
      continue;
    }
    labelsByPath[path] = normalized;
  }
  return labelsByPath;
}

export const normalizePersistedLabels = normalizePersistedPathLabels;

function canonicalPathSegments(path: string): readonly string[] {
  if (path === "/") {
    return [];
  }
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  return trimmed.length === 0
    ? []
    : trimmed.split("/").filter((segment) => segment.length > 0);
}

function mergePathLabelTemplate(
  base: PathLabelTemplate | undefined,
  override: PathLabelTemplate | undefined,
): PathLabelTemplate | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }

  const iterate = base.iterate || override.iterate
    ? {
      ...(base.iterate?.order && !override.iterate?.order
        ? { order: base.iterate.order }
        : {}),
      ...(override.iterate?.order ? { order: override.iterate.order } : {}),
      ...(base.iterate?.count && !override.iterate?.count
        ? { count: base.iterate.count }
        : {}),
      ...(override.iterate?.count ? { count: override.iterate.count } : {}),
    }
    : undefined;

  let views: Record<string, PathLabelTemplate> | undefined;
  if (base.views || override.views) {
    for (
      const key of new Set([
        ...Object.keys(base.views ?? {}),
        ...Object.keys(override.views ?? {}),
      ])
    ) {
      const merged = mergePathLabelTemplate(
        base.views?.[key],
        override.views?.[key],
      );
      if (!merged) {
        continue;
      }
      views ??= {};
      views[key] = merged;
    }
  }

  const children = mergePathLabelTemplate(base.children, override.children);
  return {
    ...(base.label && !override.label ? { label: base.label } : {}),
    ...(override.label ? { label: override.label } : {}),
    ...(base.shape && !override.shape ? { shape: base.shape } : {}),
    ...(override.shape ? { shape: override.shape } : {}),
    ...(base.value && !override.value ? { value: base.value } : {}),
    ...(override.value ? { value: override.value } : {}),
    ...(iterate &&
        (iterate.order !== undefined || iterate.count !== undefined)
      ? { iterate }
      : {}),
    ...(children ? { children } : {}),
    ...(views ? { views } : {}),
  };
}

function inheritedChildTemplate(
  template: PathLabelTemplate | undefined,
): PathLabelTemplate | undefined {
  if (!template) {
    return undefined;
  }
  if (template.children) {
    return template.children;
  }
  if (!template.label) {
    return undefined;
  }
  return { label: template.label };
}

function entryMatchesDepth(
  labelPath: string,
  segments: readonly string[],
  depth: number,
): boolean {
  const labelSegments = canonicalPathSegments(labelPath);
  if (labelSegments.length !== depth) {
    return false;
  }
  for (let index = 0; index < depth; index++) {
    if (labelSegments[index] === "*") {
      continue;
    }
    if (labelSegments[index] !== segments[index]) {
      return false;
    }
  }
  return true;
}

function entrySpecificity(labelPath: string): number {
  return canonicalPathSegments(labelPath).filter((segment) => segment !== "*")
    .length;
}

export function resolvePathLabelTemplate(
  labelsByPath: PersistedPathLabels,
  path: string,
): PathLabelTemplate | undefined {
  const segments = canonicalPathSegments(path);
  let current: PathLabelTemplate | undefined;
  let inherited: PathLabelTemplate | undefined;

  for (let depth = 0; depth <= segments.length; depth++) {
    current = inherited;
    const matchingEntries = Object.entries(labelsByPath)
      .filter(([labelPath]) => entryMatchesDepth(labelPath, segments, depth))
      .sort(([leftPath], [rightPath]) => {
        const specificityDiff = entrySpecificity(leftPath) -
          entrySpecificity(rightPath);
        return specificityDiff !== 0
          ? specificityDiff
          : leftPath.localeCompare(rightPath);
      });
    for (const [, entry] of matchingEntries) {
      current = mergePathLabelTemplate(current, entry);
    }
    inherited = inheritedChildTemplate(current);
  }

  return current;
}

function observationLabelFromTemplate(
  template: PathLabelTemplate | undefined,
  op: ReadObservationOp,
): Labels | undefined {
  if (!template) {
    return undefined;
  }

  const label = template.label;
  const shape = template.shape ?? label;
  const fieldValue = template.value ?? label;
  const iterateOrder = template.iterate?.order ?? shape;
  const iterateCount = template.iterate?.count ?? shape;

  switch (op) {
    case "shape":
      return shape;
    case "value":
      return fieldValue;
    case "enumerate":
      return iterateOrder;
    case "count":
      return iterateCount;
    case "followRef":
      return fieldValue;
  }
}

export function resolveObservationLabel(
  labelsByPath: PersistedPathLabels,
  path: string,
  op: ReadObservationOp,
): Labels | undefined {
  return observationLabelFromTemplate(
    resolvePathLabelTemplate(labelsByPath, path),
    op,
  );
}

export function labelsPresent(labelsByPath: PersistedPathLabels): boolean {
  return Object.values(labelsByPath).some((entry) =>
    Boolean(
      entry.label || entry.shape || entry.value || entry.iterate?.order ||
        entry.iterate?.count || entry.children ||
        (entry.views && Object.keys(entry.views).length > 0),
    )
  );
}

export function joinObservedLabels(
  labels: readonly (Labels | undefined)[],
): Labels | undefined {
  let classification: Labels["classification"];
  let integrity: Labels["integrity"];
  for (const label of labels) {
    classification = joinConfidentialityLabels(
      classification,
      label?.classification,
    );
    integrity = joinIntegrityLabels(integrity, label?.integrity);
  }
  if (!classification && !integrity) {
    return undefined;
  }
  return {
    ...(classification ? { classification } : {}),
    ...(integrity ? { integrity } : {}),
  };
}

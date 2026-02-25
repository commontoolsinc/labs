import { ContextualFlowControl } from "../cfc.ts";
import type { Labels } from "../storage/interface.ts";
import type { CanonicalBoundaryRead } from "./canonical-activity.ts";

export interface ConsumedReadWithEffectiveLabel {
  readonly read: CanonicalBoundaryRead;
  readonly effectiveLabel: Labels | undefined;
}

export function consumedReadEntityKey(read: CanonicalBoundaryRead): string {
  return `${read.space}\u0000${read.id}\u0000${read.type}`;
}

function pathPrefixes(path: string): string[] {
  if (path === "/") {
    return ["/"];
  }

  const pathWithoutRoot = path.startsWith("/") ? path.slice(1) : path;
  if (pathWithoutRoot.length === 0) {
    return ["/"];
  }

  const segments = pathWithoutRoot.split("/");
  const prefixes = ["/"];
  let current = "";
  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    current += `/${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}

function effectiveLabelForPath(
  labelsByPath: Record<string, Labels>,
  path: string,
  cfc: ContextualFlowControl,
): Labels | undefined {
  const classifications = new Set<string>();
  const integrity = new Set<string>();
  for (const prefix of pathPrefixes(path)) {
    const label = labelsByPath[prefix];
    if (label?.classification) {
      for (const classification of label.classification) {
        if (typeof classification === "string" && classification.length > 0) {
          classifications.add(classification);
        }
      }
    }
    if (label?.integrity) {
      for (const atom of label.integrity) {
        if (typeof atom === "string" && atom.length > 0) {
          integrity.add(atom);
        }
      }
    }
  }

  if (classifications.size === 0 && integrity.size === 0) {
    return undefined;
  }

  return {
    ...(classifications.size > 0
      ? { classification: [cfc.lub(classifications)] }
      : {}),
    ...(integrity.size > 0 ? { integrity: [...integrity].sort() } : {}),
  };
}

export function collectConsumedInputLabels(
  consumedReads: readonly CanonicalBoundaryRead[],
  labelsByEntity: ReadonlyMap<string, Record<string, Labels>>,
): readonly ConsumedReadWithEffectiveLabel[] {
  const cfc = new ContextualFlowControl();
  return consumedReads.map((read): ConsumedReadWithEffectiveLabel => {
    const labelsByPath = labelsByEntity.get(consumedReadEntityKey(read));
    if (!labelsByPath) {
      return { read, effectiveLabel: undefined };
    }
    return {
      read,
      effectiveLabel: effectiveLabelForPath(labelsByPath, read.path, cfc),
    };
  });
}

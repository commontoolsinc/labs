import { ContextualFlowControl } from "../cfc.ts";
import type { Labels } from "../storage/interface.ts";
import type { CanonicalBoundaryRead } from "./canonical-activity.ts";
import { canonicalLabelPathMatchesReadPath } from "./path-matching.ts";
import { cfcEntityKey } from "./shared.ts";

class CfcLabelLubError extends Error {
  constructor(classifications: Set<string>, cause?: unknown) {
    super(
      `CFC label LUB failed for classifications: ${
        [...classifications].sort().join(", ")
      }`,
    );
    this.name = "CfcLabelLubError";
    this.cause = cause;
  }
}

export interface ConsumedReadWithEffectiveLabel {
  readonly read: CanonicalBoundaryRead;
  readonly effectiveLabel: Labels | undefined;
}

export function consumedReadEntityKey(read: CanonicalBoundaryRead): string {
  return cfcEntityKey(read);
}

function effectiveLabelForPath(
  labelsByPath: Record<string, Labels>,
  path: string,
  cfc: ContextualFlowControl,
): Labels | undefined {
  const classifications = new Set<string>();
  const integrity = new Set<string>();
  for (const [labelPath, label] of Object.entries(labelsByPath)) {
    if (!canonicalLabelPathMatchesReadPath(labelPath, path)) {
      continue;
    }
    if (label.classification) {
      for (const classification of label.classification) {
        if (typeof classification === "string" && classification.length > 0) {
          classifications.add(classification);
        }
      }
    }
    if (label.integrity) {
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

  let lubResult: string | undefined;
  if (classifications.size > 0) {
    try {
      lubResult = cfc.lub(classifications);
    } catch (cause) {
      throw new CfcLabelLubError(classifications, cause);
    }
  }

  return {
    ...(lubResult !== undefined ? { classification: [lubResult] } : {}),
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

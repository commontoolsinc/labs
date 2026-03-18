import type { Labels } from "../storage/interface.ts";
import type { CanonicalBoundaryRead } from "./canonical-activity.ts";
import {
  joinConfidentialityLabels,
  joinIntegrityLabels,
} from "./label-algebra.ts";
import { canonicalLabelPathMatchesReadPath } from "./path-matching.ts";
import { cfcEntityKey } from "./shared.ts";

export interface ConsumedReadWithEffectiveLabel {
  readonly read: CanonicalBoundaryRead;
  readonly effectiveLabel: Labels | undefined;
}

export function consumedReadEntityKey(read: CanonicalBoundaryRead): string {
  return cfcEntityKey(read);
}

export function effectiveLabelForPath(
  labelsByPath: Record<string, Labels>,
  path: string,
): Labels | undefined {
  let classification: Labels["classification"];
  let integrity: Labels["integrity"];
  for (const [labelPath, label] of Object.entries(labelsByPath)) {
    if (!canonicalLabelPathMatchesReadPath(labelPath, path)) {
      continue;
    }
    classification = joinConfidentialityLabels(
      classification,
      label.classification,
    );
    integrity = joinIntegrityLabels(integrity, label.integrity);
  }

  if (!classification && !integrity) {
    return undefined;
  }

  return {
    ...(classification ? { classification } : {}),
    ...(integrity ? { integrity } : {}),
  };
}

export function collectConsumedInputLabels(
  consumedReads: readonly CanonicalBoundaryRead[],
  labelsByEntity: ReadonlyMap<string, Record<string, Labels>>,
): readonly ConsumedReadWithEffectiveLabel[] {
  return consumedReads.map((read): ConsumedReadWithEffectiveLabel => {
    const labelsByPath = labelsByEntity.get(consumedReadEntityKey(read));
    if (!labelsByPath) {
      return { read, effectiveLabel: undefined };
    }
    return {
      read,
      effectiveLabel: effectiveLabelForPath(labelsByPath, read.path),
    };
  });
}

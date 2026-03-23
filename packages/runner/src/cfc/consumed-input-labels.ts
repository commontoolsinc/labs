import type { Labels } from "../storage/interface.ts";
import type { CanonicalBoundaryRead } from "./canonical-activity.ts";
import {
  joinConfidentialityLabels,
  joinIntegrityLabels,
} from "./label-algebra.ts";
import {
  cfcEntityKey,
  type PersistedPathLabels,
  resolveObservationLabel,
} from "./shared.ts";

export interface ConsumedReadWithEffectiveLabel {
  readonly read: CanonicalBoundaryRead;
  readonly effectiveLabel: Labels | undefined;
}

export function consumedReadEntityKey(read: CanonicalBoundaryRead): string {
  return cfcEntityKey(read);
}

export function effectiveLabelForPath(
  labelsByPath: PersistedPathLabels,
  path: string,
): Labels | undefined {
  return resolveObservationLabel(labelsByPath, path, "value");
}

export function collectConsumedInputLabels(
  consumedReads: readonly CanonicalBoundaryRead[],
  labelsByEntity: ReadonlyMap<string, PersistedPathLabels>,
): readonly ConsumedReadWithEffectiveLabel[] {
  return consumedReads.map((read): ConsumedReadWithEffectiveLabel => {
    const labelsByPath = labelsByEntity.get(consumedReadEntityKey(read));
    if (!labelsByPath) {
      return { read, effectiveLabel: undefined };
    }
    return {
      read,
      effectiveLabel: resolveObservationLabel(
        labelsByPath,
        read.path,
        read.op,
      ),
    };
  });
}

export function joinConsumedObservationLabels(
  consumedLabels: readonly ConsumedReadWithEffectiveLabel[],
): Labels | undefined {
  let classification: Labels["classification"];
  let integrity: Labels["integrity"];
  for (const consumed of consumedLabels) {
    classification = joinConfidentialityLabels(
      classification,
      consumed.effectiveLabel?.classification,
    );
    integrity = joinIntegrityLabels(
      integrity,
      consumed.effectiveLabel?.integrity,
    );
  }
  if (!classification && !integrity) {
    return undefined;
  }
  return {
    ...(classification ? { classification } : {}),
    ...(integrity ? { integrity } : {}),
  };
}

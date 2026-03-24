import type {
  ICfcReadAnnotations,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "../storage/interface.ts";
import { ignoreReadForSchedulingMarker } from "../storage/read-metadata.ts";
import { markCfcRelevantForEffectiveLabels } from "./relevance.ts";

const ignoreReadForSchedulingMeta = {
  [ignoreReadForSchedulingMarker]: true,
} as const;

export function withInternalVerifierRead(
  options: IReadOptions = {},
): IReadOptions {
  return {
    ...options,
    cfc: {
      ...(options.cfc ?? {}),
      internalVerifierRead: true,
    },
  };
}

export function recordCfcReadObservation(
  tx: IExtendedStorageTransaction | undefined,
  address: IMemorySpaceAddress,
  cfc: ICfcReadAnnotations,
): void {
  if (!tx) {
    return;
  }
  markCfcRelevantForEffectiveLabels(
    tx,
    address,
    "ifc-read-effective-label",
    cfc.op ?? "value",
  );
  tx.readOrThrow(address, {
    trackReadWithoutLoad: true,
    meta: ignoreReadForSchedulingMeta,
    cfc,
  });
}

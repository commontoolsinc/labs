import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { entryObservationClass } from "./observation-classes.ts";
import type { CfcAddress, CfcDereferenceTrace, CfcMetadata } from "./types.ts";
import {
  canonicalizeCfcLogicalPath,
  type CfcLabelView,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-core.ts";

export type {
  CfcLabelView,
  CfcLabelViewEntry,
  IFCLabel,
} from "./label-view-core.ts";
export {
  canonicalizeCfcLogicalPath,
  cfcLabelViewPathKey,
  cfcLabelViewsEqual,
  cloneCfcLabel,
  cloneCfcLabelView,
  hasCfcLabelValues,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-core.ts";

export const cfcLabelViewSymbol: unique symbol = Symbol("cfcLabelView");

type CfcLabelCarrier = {
  [cfcLabelViewSymbol]?(): CfcLabelView | undefined;
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
      entries: metadata.labelMap.entries.flatMap((entry) => {
        // The view carries the EFFECTIVE class: the persisted
        // `origin:"link"` ⇒ implicit `followRef` carve-out (C0 §3) is
        // resolved here, so view consumers classify without knowing about
        // origins.
        const observes = entryObservationClass(entry);
        // Label-metadata population templates (template-population Stage B)
        // are envelope-LOCAL: they describe this envelope's own payload
        // entries and are re-derived per envelope at persist, so they never
        // ride label views — a link transports the source's payload labels,
        // and the target's envelope mints its own templates from whatever
        // entries land there.
        if (observes === "labelMetadata") {
          return [];
        }
        return [{
          path: entry.path,
          label: entry.label,
          ...(observes !== undefined ? { observes } : {}),
        }];
      }),
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
      canonicalizeCfcLogicalPath(address.path),
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

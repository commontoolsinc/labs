import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
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

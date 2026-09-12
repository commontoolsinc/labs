import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { immutableReferenceSourceAcquisition } from "./immutable-reference.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import { entryObservationClass } from "./observation-classes.ts";
import {
  cfcReferenceConfidentialityForView,
  type CfcReferenceProvenance,
  joinCfcReferenceConfidentiality,
  withCfcReferenceConfidentiality,
} from "./reference-provenance.ts";
import {
  type CfcAddress,
  type CfcDereferenceTrace,
  type CfcMetadata,
  runtimeWritePolicyAuthorization,
} from "./types.ts";
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

const cfcMetadataForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcMetadata | undefined => {
  const memo = tx.getSnapshotMemo?.();
  const key = `cfcViewMetadata:${address.space}|${address.scope}|${address.id}`;
  const cached = memo?.get(key) as
    | { metadata: CfcMetadata | undefined }
    | undefined;
  if (cached !== undefined) return cached.metadata;
  const metadata = readStoredCfcMetadata(tx, address, {
    authorization: tx.getCfcState().flowLabelsMode === "persist",
  });
  memo?.set(key, { metadata });
  return metadata;
};

const deriveCfcLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcLabelView | undefined =>
  cfcLabelViewFromMetadata(
    cfcMetadataForAddress(tx, address),
    canonicalizeCfcLogicalPath(address.path),
  );

/**
 * The stored labels that apply at an address, as a view rebased onto it.
 *
 * Memoized on the transaction's snapshot: the derivation reads the target
 * document's `["cfc"]` metadata and nothing else, so it answers the same until
 * something is written, and every dereference on a scanned collection asks for
 * the same handful of addresses once per element. The memoized view is shared
 * rather than copied — every consumer merges, clones or rebases it into
 * something new, none writes to it.
 */
const cfcLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  address: CfcAddress,
): CfcLabelView | undefined => {
  const memo = tx.getSnapshotMemo?.();
  if (memo === undefined) {
    return deriveCfcLabelViewForAddress(tx, address);
  }
  const key = `cfcLabels:${address.space}|${address.scope ?? ""}|` +
    `${address.id}|${JSON.stringify(address.path)}`;
  // Two-level, so a memoized `undefined` is a hit rather than a miss — an
  // address with no stored labels is the common case and the one worth having.
  const cached = memo.get(key) as
    | { view: CfcLabelView | undefined }
    | undefined;
  if (cached !== undefined) return cached.view;
  const view = deriveCfcLabelViewForAddress(
    tx,
    address,
  );
  memo.set(key, { view });
  return view;
};

/** Acquires the restrictions on a stored reference without opening its target. */
export const cfcReferenceLabelViewForAddress = (
  tx: IExtendedStorageTransaction,
  source: CfcAddress,
  sourceAcquisition?: CfcReferenceProvenance,
  onAcquisition?: (acquisition: CfcReferenceProvenance) => void,
): CfcLabelView | undefined => {
  const metadata = cfcMetadataForAddress(tx, source);
  const complete = metadata?.version === 2 && metadata.labelMap.entries.some(
    (entry) =>
      entry.origin === "link" && entry.observes === "followRef" &&
      deepEqual(
        canonicalizeCfcLogicalPath(entry.path),
        canonicalizeCfcLogicalPath(source.path),
      ),
  );
  const precise = tx.getCfcState().flowLabelsMode === "persist";
  const pendingReference = precise &&
    tx.getCfcState().writePolicyInputs.some((input) =>
      input.kind === "link-write" && deepEqual(input.target, source) &&
      tx.isRuntimeWritePolicyInput(input)
    );
  const valuePath = ["value", ...source.path];
  const pendingValue = precise &&
    [...(tx.getWriteDetails?.(source.space) ?? [])].some((detail) =>
      detail.address.id === source.id &&
      detail.address.scope === source.scope &&
      (detail.address.path.every((part, index) => valuePath[index] === part) ||
        valuePath.every((part, index) => detail.address.path[index] === part))
    );
  if (
    precise && (pendingReference || pendingValue || !complete)
  ) {
    const acquisition = tx.acquireCfcReference(
      source,
      sourceAcquisition,
      runtimeWritePolicyAuthorization,
    );
    if (acquisition === undefined) {
      throw new Error("Reference acquisition lacks complete legacy provenance");
    }
    onAcquisition?.(acquisition);
    return withCfcReferenceConfidentiality(
      undefined,
      acquisition.confidentiality,
    );
  }
  const reference = cfcLabelViewForAddress(tx, source);
  const confidentiality =
    reference?.entries.flatMap((entry) =>
      entry.path.length === 0 ? entry.label.confidentiality ?? [] : []
    ) ?? [];
  const entries = reference?.entries.filter((entry) => entry.path.length === 0)
    .map((entry) => ({ ...entry, observes: "followRef" as const }));
  return withCfcReferenceConfidentiality(
    entries?.length ? mergeCfcLabelViews([{ version: 1, entries }]) : undefined,
    confidentiality,
  );
};

export const cfcLabelViewForDereference = (
  tx: IExtendedStorageTransaction,
  source: CfcAddress,
  target: CfcAddress,
  sourceAcquisition?: CfcReferenceProvenance,
): CfcLabelView | undefined =>
  mergeCfcLabelViews([
    cfcReferenceLabelViewForAddress(tx, source, sourceAcquisition),
    cfcLabelViewForAddress(tx, target),
  ]);

export const cfcLabelViewForDereferenceTraces = (
  tx: IExtendedStorageTransaction,
  traces: readonly CfcDereferenceTrace[],
  carriedView?: CfcLabelView,
): CfcLabelView | undefined => {
  const derived: CfcLabelView[] = [];
  let referenceConfidentiality = cfcReferenceConfidentialityForView(
    carriedView,
  );
  for (const trace of traces) {
    const acquisition = immutableReferenceSourceAcquisition(
      carriedView,
      trace.source,
      referenceConfidentiality,
    );
    const view = cfcLabelViewForDereference(
      tx,
      trace.source,
      trace.target,
      acquisition,
    );
    if (view !== undefined) derived.push(view);
    referenceConfidentiality = joinCfcReferenceConfidentiality([
      withCfcReferenceConfidentiality(undefined, referenceConfidentiality),
      view,
    ]);
  }
  return mergeCfcLabelViews(derived);
};

export const getCarriedCfcLabelView = (
  value: unknown,
): CfcLabelView | undefined => {
  const carrier = value as Partial<CfcLabelCarrier> | undefined;
  if (typeof carrier?.[cfcLabelViewSymbol] !== "function") {
    return undefined;
  }
  return cloneCfcLabelView(carrier[cfcLabelViewSymbol]());
};

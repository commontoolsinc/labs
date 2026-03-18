import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  Labels,
  MemorySpace,
  URI,
} from "../storage/interface.ts";
import { computeCfcActivityDigest } from "./activity-digest.ts";
import {
  normalizeConfidentialityLabel,
  normalizeIntegrityLabel,
} from "./label-algebra.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
  toHex,
} from "./shared.ts";

const CFC_CAS_BLOB_MEDIA_TYPE = "application/json";
const CFC_CAS_LABEL_BINDING_MEDIA_TYPE = "application/json";

export interface CfcCasWriteResult {
  readonly blobHash: string;
}

export interface WriteCfcCasBlobWithBoundaryOptions {
  readonly space: MemorySpace;
  readonly payload: Uint8Array;
  readonly proposedLabel: Labels;
  readonly evaluateEffectiveLabel: (
    proposedLabel: Labels,
  ) => Labels | Promise<Labels>;
}

export interface ReadCfcCasBlobByExpectedLabelOptions {
  readonly space: MemorySpace;
  readonly blobHash: string;
  readonly expectedLabel: Labels;
  readonly canReadLabel: (
    label: Labels,
  ) => boolean | Promise<boolean>;
}

export interface WriteCfcCasBlobFromPreparedPathOptions {
  readonly space: MemorySpace;
  readonly payload: Uint8Array;
  readonly source: Pick<IMemorySpaceAddress, "space" | "id" | "type">;
  readonly sourcePath?: string;
}

export interface CfcCasBlobRecord {
  readonly blobHash: string;
  readonly bytes: readonly number[];
}

export interface CfcCasLabelBindingRecord {
  readonly blobHash: string;
  readonly bindings: readonly {
    readonly label: Labels;
  }[];
}

function normalizeCasLabel(label: Labels): Labels {
  const classification = normalizeConfidentialityLabel(label.classification);
  const integrity = normalizeIntegrityLabel(label.integrity);
  return {
    ...(classification ? { classification } : {}),
    ...(integrity ? { integrity } : {}),
  };
}

function casLabelKey(label: Labels): string {
  return JSON.stringify(normalizeCasLabel(label));
}

function refreshPreparedDigestIfNeeded(tx: IExtendedStorageTransaction): void {
  if (!tx.cfcPrepared) {
    return;
  }
  tx.markCfcPrepared(
    computeCfcActivityDigest(
      tx.journal.activity(),
      tx.resolveCfcPrepareScopeSnapshot(),
    ),
  );
}

export function computeCfcCasBlobHash(payload: Uint8Array): string {
  return toHex(
    canonicalHash(storableFromNativeValue(Array.from(payload))).hash,
  );
}

export function cfcCasBlobAddress(
  space: MemorySpace,
  blobHash: string,
): IMemorySpaceAddress {
  return {
    space,
    id: `blob:${blobHash}` as URI,
    type: CFC_CAS_BLOB_MEDIA_TYPE,
    path: [],
  };
}

export function cfcCasLabelBindingsAddress(
  space: MemorySpace,
  blobHash: string,
): IMemorySpaceAddress {
  return {
    space,
    id: `cas-binding:${blobHash}` as URI,
    type: CFC_CAS_LABEL_BINDING_MEDIA_TYPE,
    path: [],
  };
}

export function writeCfcCasBlob(
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  payload: Uint8Array,
  effectiveLabel: Labels,
): CfcCasWriteResult {
  const blobHash = computeCfcCasBlobHash(payload);
  tx.writeOrThrow(
    cfcCasBlobAddress(space, blobHash),
    {
      blobHash,
      bytes: Array.from(payload),
    } satisfies CfcCasBlobRecord,
  );

  const bindingsAddress = cfcCasLabelBindingsAddress(space, blobHash);
  const normalizedLabel = normalizeCasLabel(effectiveLabel);
  const existing = tx.readOrThrow(bindingsAddress) as
    | CfcCasLabelBindingRecord
    | undefined;
  const existingBindings = existing?.bindings ?? [];
  const alreadyBound = existingBindings.some((binding) =>
    casLabelKey(binding.label) === casLabelKey(normalizedLabel)
  );
  if (!alreadyBound) {
    tx.writeOrThrow(bindingsAddress, {
      blobHash,
      bindings: [...existingBindings, { label: normalizedLabel }],
    });
  }

  return { blobHash };
}

export async function writeCfcCasBlobWithBoundary(
  tx: IExtendedStorageTransaction,
  options: WriteCfcCasBlobWithBoundaryOptions,
): Promise<CfcCasWriteResult> {
  const effectiveLabel = await options.evaluateEffectiveLabel(
    options.proposedLabel,
  );
  const result = writeCfcCasBlob(
    tx,
    options.space,
    options.payload,
    effectiveLabel,
  );
  refreshPreparedDigestIfNeeded(tx);
  return result;
}

export function writeCfcCasBlobFromPreparedPath(
  tx: IExtendedStorageTransaction,
  options: WriteCfcCasBlobFromPreparedPathOptions,
): CfcCasWriteResult {
  const sourcePath = options.sourcePath ?? "/";
  const labelsByPath = normalizePersistedLabels(
    tx.readOrThrow(cfcLabelsAddress(options.source)),
  );
  const effectiveLabel = labelsByPath[sourcePath];
  if (!effectiveLabel) {
    throw new Error(
      `No prepared CFC label found for CAS source path ${sourcePath}`,
    );
  }

  const result = writeCfcCasBlob(
    tx,
    options.space,
    options.payload,
    effectiveLabel,
  );
  refreshPreparedDigestIfNeeded(tx);
  return result;
}

export function readCfcCasBlob(
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  blobHash: string,
): Uint8Array | undefined {
  const stored = tx.readOrThrow(cfcCasBlobAddress(space, blobHash)) as
    | CfcCasBlobRecord
    | undefined;
  if (!stored) {
    return undefined;
  }
  return new Uint8Array(stored.bytes);
}

export async function readCfcCasBlobByExpectedLabel(
  tx: IExtendedStorageTransaction,
  options: ReadCfcCasBlobByExpectedLabelOptions,
): Promise<Uint8Array | undefined> {
  const bindings = tx.readOrThrow(
    cfcCasLabelBindingsAddress(options.space, options.blobHash),
  ) as CfcCasLabelBindingRecord | undefined;
  if (!bindings) {
    return undefined;
  }

  const expectedLabelKey = casLabelKey(options.expectedLabel);
  for (const binding of bindings.bindings) {
    if (casLabelKey(binding.label) !== expectedLabelKey) {
      continue;
    }
    if (!await options.canReadLabel(binding.label)) {
      return undefined;
    }
    return readCfcCasBlob(tx, options.space, options.blobHash);
  }

  return undefined;
}

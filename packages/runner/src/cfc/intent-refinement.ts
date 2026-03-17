import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import type { Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import type { CfcEventEnvelope } from "./event-envelope.ts";
import type { CfcIntentEventPayload } from "./intent-event.ts";
import { toHex } from "./shared.ts";

export interface DeriveCfcIntentRefinementIdOptions {
  readonly sourceIntentId: string;
  readonly refinerHash: string;
}

export interface CfcIntentRefinementClaimMarker {
  readonly id: string;
  readonly space: MemorySpace;
}

export interface CfcIntentOnce<T = unknown> {
  readonly id: string;
  readonly operation: string;
  readonly parameters: T;
  readonly sourceIntentId: string;
  readonly refinerHash: string;
  readonly integrity: readonly unknown[];
}

export interface CreateCfcIntentOnceOptions<T> {
  readonly refinerHash: string;
  readonly operation: string;
  readonly parameters: T;
  readonly additionalIntegrity?: readonly unknown[];
}

function hashIntentRefinement(
  options: DeriveCfcIntentRefinementIdOptions,
  kind: "claim" | "once",
): string {
  const hash = canonicalHash(
    storableFromNativeValue({
      kind,
      sourceIntentId: options.sourceIntentId,
      refinerHash: options.refinerHash,
    }),
  );
  return toHex(hash.hash);
}

export function deriveCfcIntentRefinementClaimId(
  options: DeriveCfcIntentRefinementIdOptions,
): string {
  return `cfc:intent-refined:${hashIntentRefinement(options, "claim")}`;
}

export function deriveCfcIntentOnceId(
  options: DeriveCfcIntentRefinementIdOptions,
): string {
  return `cfc:intent-once:${hashIntentRefinement(options, "once")}`;
}

export function createCfcIntentOnce<T>(
  sourceIntent: Pick<
    CfcEventEnvelope<CfcIntentEventPayload>,
    "id" | "integrity"
  >,
  options: CreateCfcIntentOnceOptions<T>,
): CfcIntentOnce<T> {
  return {
    id: deriveCfcIntentOnceId({
      sourceIntentId: sourceIntent.id,
      refinerHash: options.refinerHash,
    }),
    operation: options.operation,
    parameters: options.parameters,
    sourceIntentId: sourceIntent.id,
    refinerHash: options.refinerHash,
    integrity: [
      ...sourceIntent.integrity,
      {
        type: "https://commonfabric.org/cfc/atom/RefinedBy",
        refiner: options.refinerHash,
        source: sourceIntent.id,
      },
      ...(options.additionalIntegrity ?? []),
    ],
  };
}

function getIntentRefinementClaimCell(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  sourceIntentId: string,
  refinerHash: string,
) {
  return runtime.getCell(
    space,
    deriveCfcIntentRefinementClaimId({
      sourceIntentId,
      refinerHash,
    }),
    undefined,
    tx,
  );
}

export function claimCfcIntentRefinement(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  sourceIntentId: string,
  refinerHash: string,
): {
  readonly alreadyRefined: boolean;
  readonly marker: CfcIntentRefinementClaimMarker;
  readonly intentOnceId: string;
} {
  const cell = getIntentRefinementClaimCell(
    runtime,
    tx,
    space,
    sourceIntentId,
    refinerHash,
  );
  const marker = {
    id: cell.getAsNormalizedFullLink().id,
    space,
  } satisfies CfcIntentRefinementClaimMarker;

  if (cell.withTx(tx).get() !== undefined) {
    return {
      alreadyRefined: true,
      marker,
      intentOnceId: deriveCfcIntentOnceId({
        sourceIntentId,
        refinerHash,
      }),
    };
  }

  cell.withTx(tx).set({
    sourceIntentId,
    refinerHash,
  });
  return {
    alreadyRefined: false,
    marker,
    intentOnceId: deriveCfcIntentOnceId({
      sourceIntentId,
      refinerHash,
    }),
  };
}

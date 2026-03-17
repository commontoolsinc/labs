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
  readonly audience: string;
  readonly endpoint: string;
  readonly parameters: T;
  readonly payloadDigest: string;
  readonly idempotencyKey: string;
  readonly exp: number;
  readonly maxAttempts: number;
  readonly duration: "short" | "long";
  readonly sourceIntentId: string;
  readonly refinerHash: string;
  readonly integrity: readonly unknown[];
}

export interface CreateCfcIntentOnceOptions<T> {
  readonly refinerHash: string;
  readonly operation: string;
  readonly audience: string;
  readonly endpoint: string;
  readonly parameters: T;
  readonly exp: number;
  readonly maxAttempts: number;
  readonly duration: "short" | "long";
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

export function computeCfcIntentPayloadDigest(parameters: unknown): string {
  const hash = canonicalHash(storableFromNativeValue(parameters));
  return `cfc:intent-payload:${toHex(hash.hash)}`;
}

export function deriveCfcIntentIdempotencyKey(
  options: {
    readonly sourceIntentId: string;
    readonly operation: string;
  },
): string {
  const hash = canonicalHash(
    storableFromNativeValue({
      sourceIntentId: options.sourceIntentId,
      operation: options.operation,
    }),
  );
  return `cfc:intent-idempotency:${toHex(hash.hash)}`;
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
    audience: options.audience,
    endpoint: options.endpoint,
    parameters: options.parameters,
    payloadDigest: computeCfcIntentPayloadDigest(options.parameters),
    idempotencyKey: deriveCfcIntentIdempotencyKey({
      sourceIntentId: sourceIntent.id,
      operation: options.operation,
    }),
    exp: options.exp,
    maxAttempts: options.maxAttempts,
    duration: options.duration,
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

export function verifyCfcShortIntentOnce(
  intent: Pick<CfcIntentOnce, "duration" | "exp">,
  now = Date.now(),
): boolean {
  if (intent.duration !== "short") {
    return false;
  }
  if (intent.exp <= now) {
    return false;
  }
  return intent.exp - now <= 5_000;
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

import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import type { Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import { toHex } from "./shared.ts";

export interface DeriveCfcIntentConsumedIdOptions {
  readonly intentOnceId: string;
}

export interface DeriveCfcIntentAttemptIdOptions
  extends DeriveCfcIntentConsumedIdOptions {
  readonly attemptNumber: number;
}

export interface CfcIntentLifecycleClaimMarker {
  readonly id: string;
  readonly space: MemorySpace;
}

export interface CfcIntentConsumedRecord {
  readonly intentOnceId: string;
  readonly committedResult?: unknown;
}

function deriveIntentLifecycleId(kind: string, value: unknown): string {
  const hash = canonicalHash(
    storableFromNativeValue({
      kind,
      value,
    }),
  );
  return toHex(hash.hash);
}

export function deriveCfcIntentConsumedId(
  options: DeriveCfcIntentConsumedIdOptions,
): string {
  return `cfc:intent-consumed:${
    deriveIntentLifecycleId("consumed", {
      intentOnceId: options.intentOnceId,
    })
  }`;
}

export function deriveCfcIntentAttemptId(
  options: DeriveCfcIntentAttemptIdOptions,
): string {
  return `cfc:intent-attempt:${
    deriveIntentLifecycleId("attempt", {
      intentOnceId: options.intentOnceId,
      attemptNumber: options.attemptNumber,
    })
  }`;
}

function claimCfcIntentLifecycleCell(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  id: string,
  value: unknown,
): {
  readonly alreadyClaimed: boolean;
  readonly marker: CfcIntentLifecycleClaimMarker;
  readonly record?: unknown;
} {
  const cell = runtime.getCell(space, id, undefined, tx);
  const marker = {
    id: cell.getAsNormalizedFullLink().id,
    space,
  } satisfies CfcIntentLifecycleClaimMarker;
  const existing = cell.withTx(tx).get();

  if (existing !== undefined) {
    return {
      alreadyClaimed: true,
      marker,
      record: existing,
    };
  }

  cell.withTx(tx).set(value);
  return {
    alreadyClaimed: false,
    marker,
  };
}

export function claimCfcIntentAttempt(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  intentOnceId: string,
  attemptNumber: number,
): {
  readonly alreadyClaimed: boolean;
  readonly marker: CfcIntentLifecycleClaimMarker;
  readonly record?: unknown;
} {
  return claimCfcIntentLifecycleCell(
    runtime,
    tx,
    space,
    deriveCfcIntentAttemptId({
      intentOnceId,
      attemptNumber,
    }),
    {
      intentOnceId,
      attemptNumber,
    },
  );
}

export function claimCfcIntentConsumed(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  intentOnceId: string,
  record: Omit<CfcIntentConsumedRecord, "intentOnceId"> = {},
): {
  readonly alreadyClaimed: boolean;
  readonly marker: CfcIntentLifecycleClaimMarker;
  readonly record?: unknown;
} {
  return claimCfcIntentLifecycleCell(
    runtime,
    tx,
    space,
    deriveCfcIntentConsumedId({
      intentOnceId,
    }),
    {
      intentOnceId,
      ...record,
    },
  );
}

export function readCfcIntentConsumedRecord(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  intentOnceId: string,
): CfcIntentConsumedRecord | undefined {
  return runtime.getCell(
    space,
    deriveCfcIntentConsumedId({
      intentOnceId,
    }),
    undefined,
    tx,
  ).withTx(tx).get() as CfcIntentConsumedRecord | undefined;
}

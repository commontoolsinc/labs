import type {
  IExtendedStorageTransaction,
  IReadActivity,
  IWriteAttempt,
} from "../storage/interface.ts";
import type { CfcAddress } from "./types.ts";

export type CfcLogicalWriteAttempt = {
  readonly target: CfcAddress;
  readonly reads: readonly IReadActivity[];
  readonly writes: readonly IWriteAttempt[];
};

const logicalWriteAttempts = new WeakMap<
  IExtendedStorageTransaction,
  CfcLogicalWriteAttempt[]
>();

export const recordCfcLogicalWriteAttempt = (
  tx: IExtendedStorageTransaction,
  attempt: CfcLogicalWriteAttempt,
): void => {
  const attempts = logicalWriteAttempts.get(tx);
  if (attempts === undefined) {
    logicalWriteAttempts.set(tx, [attempt]);
  } else {
    attempts.push(attempt);
  }
};

export const getCfcLogicalWriteAttempts = (
  tx: IExtendedStorageTransaction,
): readonly CfcLogicalWriteAttempt[] => logicalWriteAttempts.get(tx) ?? [];

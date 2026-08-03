import type { ActionClaimKey } from "@commonfabric/memory/v2";
import type { TelemetryAnnotations } from "../scheduler/types.ts";

export interface StaleDemandedReaderSchedulerIdentity {
  readonly branch: string;
  readonly ownerSpace?: string;
  readonly pieceId: string;
  readonly processGeneration: number;
  readonly actionId: string;
  readonly executionContextKey: string;
}

const schedulerIdentityKey = (identity: {
  branch: string;
  ownerSpace: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: string;
}): string =>
  JSON.stringify([
    identity.branch,
    identity.ownerSpace,
    identity.pieceId,
    identity.processGeneration,
    identity.actionId,
    identity.executionContextKey,
  ]);

export const schedulerIdentityKeyForAction = (
  action: object,
  key: ActionClaimKey,
): string => {
  const identity = (action as Partial<TelemetryAnnotations>)
    .schedulerObservationIdentity;
  return schedulerIdentityKey({
    branch: key.branch,
    ownerSpace: key.space,
    pieceId: key.pieceId,
    processGeneration: identity?.processGeneration ?? 0,
    actionId: key.actionId,
    executionContextKey: key.contextKey,
  });
};

export const schedulerIdentityKeyForStaleReader = (
  reader: StaleDemandedReaderSchedulerIdentity,
): string | undefined => {
  if (reader.ownerSpace === undefined) return undefined;
  return schedulerIdentityKey({
    branch: reader.branch,
    ownerSpace: reader.ownerSpace,
    pieceId: reader.pieceId,
    processGeneration: reader.processGeneration,
    actionId: reader.actionId,
    executionContextKey: reader.executionContextKey,
  });
};

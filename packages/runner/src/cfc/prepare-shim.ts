import { hasWriteActivity } from "./canonical-activity.ts";
import { prepareBoundaryCommit } from "./prepare-engine.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { computeCfcActivityDigest } from "./activity-digest.ts";

export interface PrepareCfcCommitIfNeededOptions {
  readonly enforceBoundary?: boolean;
}

export function isCommitBearingAttempt(
  tx: IExtendedStorageTransaction,
): boolean {
  return tx.cfcOutboxSize > 0 || hasWriteActivity(tx.journal.activity());
}

export async function prepareCfcCommitIfNeeded(
  tx: IExtendedStorageTransaction,
  options: PrepareCfcCommitIfNeededOptions = {},
): Promise<void> {
  if (!isCommitBearingAttempt(tx)) {
    return;
  }
  if (!tx.cfcRelevant) {
    return;
  }
  if (options.enforceBoundary === false) {
    const digest = await computeCfcActivityDigest(tx.journal.activity());
    tx.markCfcPrepared(digest);
    return;
  }
  await prepareBoundaryCommit(tx);
}

import { computeCfcActivityDigest } from "./activity-digest.ts";
import { hasWriteActivity } from "./canonical-activity.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

export function isCommitBearingAttempt(
  tx: IExtendedStorageTransaction,
): boolean {
  return tx.cfcOutboxSize > 0 || hasWriteActivity(tx.journal.activity());
}

export async function prepareCfcCommitIfNeeded(
  tx: IExtendedStorageTransaction,
): Promise<void> {
  if (!isCommitBearingAttempt(tx)) {
    return;
  }
  if (!tx.cfcRelevant) {
    return;
  }
  const digest = await computeCfcActivityDigest(tx.journal.activity());
  tx.markCfcPrepared(digest);
}

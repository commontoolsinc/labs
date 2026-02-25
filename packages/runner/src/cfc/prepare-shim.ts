import { hasWriteActivity } from "./canonical-activity.ts";
import { prepareBoundaryCommit } from "./prepare-engine.ts";
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
  await prepareBoundaryCommit(tx);
}

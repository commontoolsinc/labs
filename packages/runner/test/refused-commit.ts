/**
 * A test meets the CFC commit boundary in one of two ways. It arranges a
 * refusal, because its subject is what happens after one, or it prepares the
 * transaction and reads the refusal a gate decided. Each way has a helper
 * here.
 */

import { plainReason } from "../src/cfc/verdict-reason.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * Makes the commit boundary refuse `tx`, and says in `reason` what the case
 * wanted a refusal for.
 *
 * A transaction CFC holds relevant is refused when it reaches commit without
 * having been prepared, so marking one relevant is a rejection a test can
 * arrange in-process. The refusal carries no reason and travels under the
 * retryable `StorageTransactionAborted` name, which is why a case reading a
 * gate's own verdict wants {@link prepareAndCommit} instead.
 *
 * The refusal exists from `enforce-explicit` upward, so a transaction below
 * that is raised to it. A caller's own stricter rung is left alone, and a
 * caller that names none takes this rung rather than whatever the fleet
 * default resolves to.
 */
export const refuseAtCommitBoundary = (
  tx: IExtendedStorageTransaction,
  reason: string,
): void => {
  const mode = tx.getCfcState().enforcementMode;
  if (mode !== "enforce-explicit" && mode !== "enforce-strict") {
    tx.setCfcEnforcementMode("enforce-explicit");
  }
  tx.markCfcRelevant(`test refusal: ${reason}`);
};

/**
 * Prepares `tx` the way the runtime's own commit paths do, commits it, and
 * reports the reasons prepare refused it over alongside the commit result.
 * The reasons come back with their verdict tag stripped, as the boundary
 * renders them into the rejection.
 *
 * The prepare is what makes the commit's refusal the gate's own: an unprepared
 * transaction is refused for arriving unprepared, and that refusal names no
 * gate.
 */
export const prepareAndCommit = async (
  tx: IExtendedStorageTransaction,
): Promise<{
  reasons: readonly string[];
  result: Awaited<ReturnType<IExtendedStorageTransaction["commit"]>>;
}> => {
  tx.prepareCfc();
  const prepare = tx.getCfcState().prepare;
  return {
    reasons: prepare.status === "invalidated"
      ? prepare.reasons.map(plainReason)
      : [],
    result: await tx.commit(),
  };
};

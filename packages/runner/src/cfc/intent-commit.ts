import type { Runtime } from "../runtime.ts";
import type { CommitError, MemorySpace } from "../storage/interface.ts";
import {
  type CfcIntentLifecycleClaimMarker,
  claimCfcIntentAttempt,
  claimCfcIntentConsumed,
  readCfcIntentConsumedRecord,
} from "./intent-consumption.ts";
import type { CfcIntentOnce } from "./intent-refinement.ts";

export interface CfcIntentCommitResult {
  readonly success: boolean;
  readonly deduplicated?: boolean;
  readonly error?: string;
  readonly attemptNumber?: number;
  readonly result?: unknown;
}

export interface CommitCfcIntentWithRetriesOptions {
  readonly now?: () => number;
}

function isIntentLifecycleClaimConflict(
  error: CommitError | undefined,
  marker: CfcIntentLifecycleClaimMarker | undefined,
): boolean {
  if (!error || error.name !== "ConflictError" || !marker) {
    return false;
  }

  return error.conflict.space === marker.space &&
    error.conflict.of === marker.id;
}

export async function commitCfcIntentWithRetries<T>(
  runtime: Runtime,
  space: MemorySpace,
  intent: CfcIntentOnce<T>,
  commitActionForAttempt: (
    attemptNumber: number,
  ) => Promise<CfcIntentCommitResult>,
  options: CommitCfcIntentWithRetriesOptions = {},
): Promise<CfcIntentCommitResult> {
  const now = options.now ?? (() => Date.now());
  if (now() > intent.exp) {
    return { success: false, error: "intent_expired" };
  }

  const consumedReadTx = runtime.edit();
  const consumedRecord = readCfcIntentConsumedRecord(
    runtime,
    consumedReadTx,
    space,
    intent.id,
  );
  await consumedReadTx.abort();
  if (consumedRecord) {
    return {
      success: true,
      deduplicated: true,
      result: (consumedRecord.committedResult as CfcIntentCommitResult | undefined)
        ?.result,
    };
  }

  for (let attempt = 1; attempt <= intent.maxAttempts; attempt++) {
    if (now() > intent.exp) {
      return { success: false, error: "intent_expired" };
    }

    const attemptTx = runtime.edit();
    const attemptClaim = claimCfcIntentAttempt(
      runtime,
      attemptTx,
      space,
      intent.id,
      attempt,
    );
    if (attemptClaim.alreadyClaimed) {
      await attemptTx.abort();
      continue;
    }

    const attemptCommit = await attemptTx.commit();
    if (attemptCommit.error) {
      continue;
    }

    const result = await commitActionForAttempt(attempt);
    if (!result.success) {
      continue;
    }

    const consumeTx = runtime.edit();
    const consumedClaim = claimCfcIntentConsumed(
      runtime,
      consumeTx,
      space,
      intent.id,
      {
        committedResult: result,
      },
    );
    if (consumedClaim.alreadyClaimed) {
      await consumeTx.abort();
      return {
        success: true,
        deduplicated: true,
        result:
          (consumedClaim.record as { committedResult?: CfcIntentCommitResult } | undefined)
            ?.committedResult?.result,
      };
    }

    const consumeCommit = await consumeTx.commit();
    if (consumeCommit.error) {
      if (
        isIntentLifecycleClaimConflict(
          consumeCommit.error,
          consumedClaim.marker,
        )
      ) {
        return {
          success: true,
          deduplicated: true,
          result:
            (consumedClaim.record as { committedResult?: CfcIntentCommitResult } | undefined)
              ?.committedResult?.result,
        };
      }
      return {
        success: false,
        error: "intent_consume_commit_failed",
        attemptNumber: attempt,
      };
    }

    return {
      success: true,
      attemptNumber: attempt,
      result: result.result,
    };
  }

  return { success: false, error: "max_attempts_exceeded" };
}

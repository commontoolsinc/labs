import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadActivity,
  IStorageTransaction,
  IWriteAttempt,
  MemorySpace,
  TransactionReactivityLog,
  TransactionReadDetail,
  TransactionWriteDetail,
} from "./interface.ts";

type TxLike = IStorageTransaction | IExtendedStorageTransaction;

const unwrap = (tx: TxLike): IStorageTransaction => {
  return "tx" in tx ? tx.tx : tx;
};

export function getDirectTransactionMergeableOpAddresses(
  tx: TxLike,
): Iterable<IMemorySpaceAddress> | undefined {
  return tx.getMergeableOpAddresses?.() ??
    unwrap(tx).getMergeableOpAddresses?.();
}

export function getDirectTransactionReactivityLog(
  tx: TxLike,
): TransactionReactivityLog | undefined {
  return tx.getReactivityLog?.() ?? unwrap(tx).getReactivityLog?.();
}

export function getDirectTransactionReadActivities(
  tx: TxLike,
): Iterable<IReadActivity> | undefined {
  return tx.getReadActivities?.() ?? unwrap(tx).getReadActivities?.();
}

export function getTransactionReadActivities(
  tx: TxLike,
): Iterable<IReadActivity> {
  const direct = getDirectTransactionReadActivities(tx);
  if (direct) {
    return direct;
  }
  // Journal fallback: the activity stream is the temporal read|write
  // interleaving, so the stream position doubles as the activity-clock
  // stamp V2 transactions record natively (see IReadActivity.journalIndex).
  // getTransactionWriteAttempts derives write indices from the same
  // enumeration, keeping both on one clock.
  return (function* () {
    let journalIndex = 0;
    for (const activity of tx.journal.activity()) {
      if ("read" in activity && activity.read) {
        yield { ...activity.read, journalIndex };
      }
      journalIndex += 1;
    }
  })();
}

/**
 * Ordered log of the transaction's applied write attempts, on the same
 * per-transaction activity clock as `getTransactionReadActivities`. Prefers
 * the transaction's native log (V2); falls back to deriving positional
 * indices from the journal activity stream. Returns undefined when neither
 * source exists — callers must treat that as "order unknown" and fail toward
 * transaction-global gating (docs/specs/cfc-write-prefix-provenance.md §4).
 */
export function getTransactionWriteAttempts(
  tx: TxLike,
): readonly IWriteAttempt[] | undefined {
  const direct = tx.getWriteAttemptLog?.() ??
    unwrap(tx).getWriteAttemptLog?.();
  if (direct) {
    return direct;
  }
  try {
    const attempts: IWriteAttempt[] = [];
    let journalIndex = 0;
    for (const activity of tx.journal.activity()) {
      if ("write" in activity && activity.write) {
        attempts.push({ ...activity.write, journalIndex });
      }
      journalIndex += 1;
    }
    return attempts;
  } catch {
    // V2 journals throw on activity(); a V2 transaction always provides the
    // native log above, so reaching here means a custom transaction with
    // neither source.
    return undefined;
  }
}

export function getTransactionReadDetails(
  tx: TxLike,
  space: MemorySpace,
): Iterable<TransactionReadDetail> {
  const direct = tx.getReadDetails?.(space) ??
    unwrap(tx).getReadDetails?.(space);
  if (direct) {
    return direct;
  }

  // Chronicle-style transactions record read invariants as journal history.
  return (function* () {
    for (const attestation of tx.journal.history(space)) {
      yield {
        address: { ...attestation.address, space },
        value: attestation.value as TransactionReadDetail["value"],
      };
    }
  })();
}

export function getTransactionWriteDetails(
  tx: TxLike,
  space: MemorySpace,
): Iterable<TransactionWriteDetail> {
  const direct = tx.getWriteDetails?.(space) ??
    unwrap(tx).getWriteDetails?.(space);
  if (direct) {
    return direct;
  }

  return (function* () {
    const previousValues = new Map<
      string,
      TransactionWriteDetail["previousValue"]
    >();
    for (const attestation of tx.journal.history(space)) {
      previousValues.set(
        `${attestation.address.id}:${attestation.address.path.join(".")}`,
        attestation.value as TransactionWriteDetail["previousValue"],
      );
    }

    for (const attestation of tx.journal.novelty(space)) {
      const key = `${attestation.address.id}:${
        attestation.address.path.join(".")
      }`;
      const detail: TransactionWriteDetail = {
        address: {
          ...attestation.address,
          space,
        },
        value: attestation.value as TransactionWriteDetail["value"],
        previousValue: previousValues.get(key),
      };
      yield detail;
    }
  })();
}

import type {
  IExtendedStorageTransaction,
  IReadActivity,
  IStorageTransaction,
  MemorySpace,
  TransactionReactivityLog,
  TransactionWriteDetail,
} from "./interface.ts";

type TxLike = IStorageTransaction | IExtendedStorageTransaction;

const unwrap = (tx: TxLike): IStorageTransaction => {
  return "tx" in tx ? tx.tx : tx;
};

export function getDirectTransactionReactivityLog(
  tx: TxLike,
): TransactionReactivityLog | undefined {
  return tx.getReactivityLog?.() ?? unwrap(tx).getReactivityLog?.();
}

export function getTransactionReadActivities(
  tx: TxLike,
): Iterable<IReadActivity> {
  const direct = tx.getReadActivities?.() ?? unwrap(tx).getReadActivities?.();
  if (direct) {
    return direct;
  }
  return (function* () {
    for (const activity of tx.journal.activity()) {
      if ("read" in activity && activity.read) {
        yield activity.read;
      }
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

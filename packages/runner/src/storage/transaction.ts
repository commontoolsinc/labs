import type {
  CommitError,
  IAttestation,
  IMemorySpaceAddress,
  InactiveTransactionError,
  IStorageManager,
  IStorageTransaction,
  IStorageTransactionAborted,
  IStorageTransactionComplete,
  IStorageTransactionWriteIsolationError,
  ITransactionReader,
  ITransactionWriter,
  JSONValue,
  MemorySpace,
  ReaderError,
  Result,
  StorageTransactionFailed,
  StorageTransactionStatus,
  Unit,
  WriteError,
  WriterError,
} from "./interface.ts";

import * as Journal from "./transaction/journal.ts";

export const create = (manager: IStorageManager) =>
  new StorageTransaction({
    status: "ready",
    storage: manager,
    journal: Journal.open(manager),
    writer: null,
  });

export type EditableState = {
  status: "ready";
  storage: IStorageManager;
  journal: Journal.Journal;
  writer: ITransactionWriter | null;
};

export type SumbittedState = {
  status: "pending";
  journal: Journal.Journal;
  promise: Promise<Result<Unit, StorageTransactionFailed>>;
};

export type CompleteState = {
  status: "done";
  journal: Journal.Journal;
  result: Result<Unit, StorageTransactionFailed>;
};

export type State =
  | EditableState
  | SumbittedState
  | CompleteState;

/**
 * Storage transaction implementation that maintains consistency guarantees
 * for reads and writes across memory spaces.
 */
class StorageTransaction implements IStorageTransaction {
  static mutate(transaction: StorageTransaction, state: State) {
    transaction.#state = state;
  }
  static use(transaction: StorageTransaction): State {
    return transaction.#state;
  }

  #state: State;
  constructor(state: State) {
    this.#state = state;
  }

  status(): StorageTransactionStatus {
    return status(this);
  }

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    return reader(this, space);
  }

  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
    return writer(this, space);
  }

  read(address: IMemorySpaceAddress) {
    return read(this, address);
  }

  write(address: IMemorySpaceAddress, value?: JSONValue) {
    return write(this, address);
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    return abort(this, reason);
  }

  commit(): Promise<Result<Unit, CommitError>> {
    return commit(this);
  }
}

const { mutate, use } = StorageTransaction;

/**
 * Returns given transaction status.
 */
export const status = (
  transaction: StorageTransaction,
): StorageTransactionStatus => {
  const state = use(transaction);
  if (state.status === "done") {
    return state.result.error ? state.result : { ok: state };
  } else {
    return { ok: state };
  }
};

/**
 * Returns transaction state if it is editable otherwise fails with error.
 */
const edit = (
  transaction: StorageTransaction,
): Result<EditableState, InactiveTransactionError> => {
  const state = use(transaction);
  if (state.status === "ready") {
    return { ok: state };
  } else {
    return { error: new TransactionCompleteError() };
  }
};

/**
 * Opens a transaction reader for the given space or fails if transaction is
 * no longer editable.
 */
export const reader = (
  transaction: StorageTransaction,
  space: MemorySpace,
): Result<ITransactionReader, ReaderError> => {
  const { error, ok: ready } = edit(transaction);
  if (error) {
    return { error };
  } else {
    return ready.journal.reader(space);
  }
};

/**
 * Opens a transaction writer for the given space or fails if transaction is
 * no longer editable or if writer for a different space is open.
 */
export const writer = (
  transaction: StorageTransaction,
  space: MemorySpace,
): Result<ITransactionWriter, WriterError> => {
  const { error, ok: ready } = edit(transaction);
  if (error) {
    return { error };
  } else {
    const writer = ready.writer;
    if (writer) {
      if (writer.did() === space) {
        return { ok: writer };
      } else {
        return {
          error: new WriteIsolationError({
            open: writer.did(),
            requested: space,
          }),
        };
      }
    } else {
      const { error, ok: writer } = ready.journal.writer(space);
      if (error) {
        switch (error.name) {
          case "StorageTransactionCompleteError":
          case "StorageTransactionAborted": {
            return { error };
          }
          default: {
            mutate(transaction, {
              status: "done",
              journal: ready.journal,
              result: { error },
            });
            return { error };
          }
        }
      } else {
        ready.writer = writer;
        return { ok: writer };
      }
    }
  }
};

export const read = (
  transaction: StorageTransaction,
  address: IMemorySpaceAddress,
) => {
  const { ok: space, error } = reader(transaction, address.space);
  if (error) {
    return { error };
  } else {
    return space.read(address);
  }
};

export const write = (
  transaction: StorageTransaction,
  address: IMemorySpaceAddress,
  value?: JSONValue,
): Result<IAttestation, WriterError | WriteError> => {
  const { ok: space, error } = writer(transaction, address.space);
  if (error) {
    return { error };
  } else {
    return space.write(address, value);
  }
};

export const abort = (
  transaction: StorageTransaction,
  reason: unknown,
): Result<Unit, InactiveTransactionError> => {
  const { error, ok: ready } = edit(transaction);
  if (error) {
    return { error };
  } else {
    const { error } = ready.journal.abort(reason);
    if (error) {
      return { error };
    } else {
      mutate(transaction, {
        status: "done",
        journal: ready.journal,
        result: {
          error: new TransactionAborted(reason),
        },
      });
    }
    return { ok: {} };
  }
};

export const commit = async (
  transaction: StorageTransaction,
): Promise<Result<Unit, CommitError>> => {
  const { error, ok: ready } = edit(transaction);
  if (error) {
    return { error };
  } else {
    const { error, ok: archive } = ready.journal.close();
    if (error) {
      mutate(transaction, {
        status: "done",
        journal: ready.journal,
        result: { error: error as StorageTransactionFailed },
      });
      return { error };
    } else {
      const { writer, storage } = ready;
      const replica = writer ? storage.open(writer.did()).replica : null;
      const changes = replica ? archive.get(replica.did()) : null;
      const promise = changes
        ? replica!.commit(changes)
        : Promise.resolve({ ok: {} });

      mutate(transaction, {
        status: "pending",
        journal: ready.journal,
        promise,
      });

      const result = await promise;
      mutate(transaction, {
        status: "done",
        journal: ready.journal,
        result,
      });

      return result;
    }
  }
};

export class TransactionCompleteError extends RangeError
  implements IStorageTransactionComplete {
  override name = "StorageTransactionCompleteError" as const;
}

export class TransactionAborted extends RangeError
  implements IStorageTransactionAborted {
  override name = "StorageTransactionAborted" as const;
  reason: unknown;

  constructor(reason?: unknown) {
    super("Transaction was aborted");
    this.reason = reason;
  }
}

export class WriteIsolationError extends RangeError
  implements IStorageTransactionWriteIsolationError {
  override name = "StorageTransactionWriteIsolationError" as const;
  open: MemorySpace;
  requested: MemorySpace;
  constructor(
    { open, requested }: { open: MemorySpace; requested: MemorySpace },
  ) {
    super(
      `Can not open transaction writer for ${requested} beacuse transaction has writer open for ${open}`,
    );
    this.open = open;
    this.requested = requested;
  }
}

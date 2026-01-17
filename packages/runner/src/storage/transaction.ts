import { getLogger } from "@commontools/utils/logger";
import type {
  Activity,
  ChangeGroup,
  CommitError,
  IAttestation,
  IMemorySpaceAddress,
  InactiveTransactionError,
  IReadOptions,
  IStorageManager,
  IStorageTransaction,
  IStorageTransactionAborted,
  IStorageTransactionComplete,
  JSONValue,
  MemorySpace,
  Result,
  StorageTransactionFailed,
  StorageTransactionStatus,
  Unit,
  WriteError,
} from "./interface.ts";

import * as Chronicle from "./transaction/chronicle.ts";

const logger = getLogger("storage-transaction", {
  enabled: false,
  level: "debug",
});

export const create = (manager: IStorageManager) =>
  new StorageTransaction({
    status: "ready",
    storage: manager,
    branches: new Map(),
    activity: [],
  });

export type EditableState = {
  status: "ready";
  storage: IStorageManager;
  branches: Map<MemorySpace, Chronicle.Chronicle>;
  activity: Activity[];
};

export type SumbittedState = {
  status: "pending";
  branches: Map<MemorySpace, Chronicle.Chronicle>;
  activity: Activity[];
  promise: Promise<Result<Unit, StorageTransactionFailed>>;
};

export type CompleteState = {
  status: "done";
  branches: Map<MemorySpace, Chronicle.Chronicle>;
  activity: Activity[];
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
  changeGroup?: ChangeGroup;

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

  get branches() {
    return this.#state.branches;
  }

  get activity() {
    return this.#state.activity;
  }

  status(): StorageTransactionStatus {
    return status(this);
  }

  read(address: IMemorySpaceAddress, options?: IReadOptions) {
    return read(this, address, options);
  }

  write(address: IMemorySpaceAddress, value?: JSONValue) {
    return write(this, address, value);
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
    if (state.result.error) {
      return {
        status: "error",
        branches: state.branches,
        activity: state.activity,
        error: state.result.error,
      };
    } else {
      return {
        status: "done",
        branches: state.branches,
        activity: state.activity,
      };
    }
  } else {
    return {
      status: state.status,
      branches: state.branches,
      activity: state.activity,
    };
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
    return { error: TransactionCompleteError() };
  }
};

/**
 * Gets or creates a Chronicle for the given memory space.
 */
const checkout = (
  transaction: StorageTransaction,
  space: MemorySpace,
): Result<Chronicle.Chronicle, InactiveTransactionError> => {
  const { error, ok: ready } = edit(transaction);
  if (error) {
    return { error };
  } else {
    const branch = ready.branches.get(space);
    if (branch) {
      return { ok: branch };
    } else {
      const { replica } = ready.storage.open(space);
      const branch = Chronicle.open(replica);
      ready.branches.set(space, branch);
      return { ok: branch };
    }
  }
};

export const read = (
  transaction: StorageTransaction,
  address: IMemorySpaceAddress,
  options?: IReadOptions,
) => {
  const { ok: branch, error } = checkout(transaction, address.space);
  if (error) {
    return { error };
  } else {
    // Track read activity with metadata
    const state = use(transaction);
    state.activity.push({
      read: {
        ...address,
        meta: options?.meta ?? {},
      },
    });

    const { space: _, ...memoryAddress } = address;
    const result = branch.read(memoryAddress, options);

    // Special handling for source path, API is to always return object
    // We should return objects, but we get JSON strings from transaction, so we convert
    if (
      result.ok && address.path.length === 1 && address.path[0] === "source"
    ) {
      const value = result.ok.value;
      logger.debug("storage-source-read", () => [
        `Read source path for ${address.id}`,
        `Value type: ${typeof value}`,
        `Value: ${JSON.stringify(value)}`,
      ]);

      if (typeof value === "string" && value.startsWith('{"/":')) {
        try {
          // Parse the JSON string to return an object
          const parsedValue = JSON.parse(value);
          // Create a new attestation with the parsed value
          result.ok = {
            address: result.ok.address,
            value: parsedValue,
          };
          logger.debug("storage-source-parse", () => [
            `Parsed JSON string to object`,
            `Result: ${JSON.stringify(parsedValue)}`,
          ]);
        } catch (e) {
          // If parsing fails, leave it as is
          logger.error("storage-error", () => [
            `[SOURCE PATH] Failed to parse JSON string`,
            `Error: ${e}`,
          ]);
        }
      }
    }

    if (result.error) {
      return { error: result.error.from(address.space) };
    } else {
      return result;
    }
  }
};

export const write = (
  transaction: StorageTransaction,
  address: IMemorySpaceAddress,
  value?: JSONValue,
): Result<IAttestation, WriteError> => {
  const { ok: branch, error } = checkout(transaction, address.space);
  if (error) {
    return { error };
  } else {
    const { space: _, ...memoryAddress } = address;
    const result = branch.write(memoryAddress, value);

    if (result.error) {
      return { error: result.error.from(address.space) };
    } else {
      // Track write activity
      const state = use(transaction);
      state.activity.push({ write: address });
      return result;
    }
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
    mutate(transaction, {
      status: "done",
      branches: ready.branches,
      activity: ready.activity,
      result: {
        error: TransactionAborted(reason),
      },
    });
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
    // Validate and collect transactions from all Chronicles
    const archive: Map<MemorySpace, any> = new Map();
    for (const [space, chronicle] of ready.branches) {
      const { error, ok } = chronicle.commit();
      if (error) {
        mutate(transaction, {
          status: "done",
          branches: ready.branches,
          activity: ready.activity,
          result: { error: error as StorageTransactionFailed },
        });
        return { error };
      } else {
        archive.set(space, ok);
      }
    }

    // Commit to replicas for each space that has writes
    const { storage, branches, activity } = ready;
    let hasWrites = false;
    let writeCount = 0;

    for (const [_space, changes] of archive) {
      if (changes.facts.length > 0) {
        hasWrites = true;
        writeCount += changes.facts.length;
      }
    }

    if (hasWrites) {
      logger.debug("storage-commit-writes", () => [
        `Committing ${writeCount} writes across ${archive.size} space(s)`,
      ]);
    }

    const commitPromises: Promise<Result<Unit, any>>[] = [];
    for (const [space, changes] of archive) {
      if (changes.facts.length > 0) {
        const replica = storage.open(space).replica;
        commitPromises.push(replica.commit(changes, transaction));
      }
    }

    const promise = commitPromises.length > 0
      ? Promise.all(commitPromises).then((results) => {
        for (const result of results) {
          if (result.error) {
            return result;
          }
        }
        return { ok: {} };
      })
      : Promise.resolve({ ok: {} });

    mutate(transaction, {
      status: "pending",
      branches,
      activity,
      promise,
    });

    const result = await promise;
    mutate(transaction, {
      status: "done",
      branches,
      activity,
      result,
    });

    return result;
  }
};

export const TransactionCompleteError = (): IStorageTransactionComplete => ({
  name: "StorageTransactionCompleteError",
  message: "Transaction is complete",
});

export const TransactionAborted = (
  reason?: unknown,
): IStorageTransactionAborted => ({
  name: "StorageTransactionAborted",
  message: "Transaction was aborted",
  reason,
});

import { isRecord } from "@commontools/utils/types";
import { getLogger } from "@commontools/utils/logger";
import type { JSONValue } from "@commontools/memory/interface";
import type {
  CommitError,
  IAttestation,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  InactiveTransactionError,
  INotFoundError,
  IReadOptions,
  IStorageTransaction,
  ITransactionJournal,
  ITransactionReader,
  ITransactionWriter,
  MemorySpace,
  ReaderError,
  ReadError,
  Result,
  StorageTransactionStatus,
  Unit,
  WriteError,
  WriterError,
} from "./interface.ts";
import { toThrowable } from "./interface.ts";

import { ignoreReadForScheduling } from "../scheduler.ts";
import { isArrayIndexPropertyName } from "../value-codec.ts";

const logger = getLogger("extended-storage-transaction", {
  enabled: false,
  level: "debug",
});

const logResult = (
  kind: string,
  result: Result<any, any>,
  ...args: unknown[]
) => {
  if (result.error) {
    logger.error("storage-error", `${kind} Error`, result.error, ...args);
  } else {
    logger.info("storage", `${kind} Success`, result.ok, ...args);
  }
};

export class ExtendedStorageTransaction implements IExtendedStorageTransaction {
  private commitCallbacks = new Set<
    (tx: IExtendedStorageTransaction) => void
  >();

  constructor(public tx: IStorageTransaction) {}

  get journal(): ITransactionJournal {
    return this.tx.journal;
  }

  status(): StorageTransactionStatus {
    return this.tx.status();
  }

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    return this.tx.reader(space);
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    const result = this.tx.read(address, options);
    logResult("read", result, address, options);
    return result;
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): JSONValue | undefined {
    const readResult = this.tx.read(address, options);
    logResult("readOrThrow, initial", readResult, address, options);
    if (
      readResult.error &&
      readResult.error.name !== "NotFoundError" &&
      // Type mismatch is treated as undefined in other path resolution logic,
      // so we're consistent with that behavior here. This hides information
      // from someone who has rights to read a subpath, but otherwise get no
      // information about parent paths.
      readResult.error.name !== "TypeMismatchError"
    ) {
      throw toThrowable(readResult.error);
    }
    return readResult.ok?.value;
  }

  readValueOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): JSONValue | undefined {
    return this.readOrThrow(
      { ...address, path: ["value", ...address.path] },
      options,
    );
  }

  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
    return this.tx.writer(space);
  }

  write(
    address: IMemorySpaceAddress,
    value: any,
  ): Result<IAttestation, WriteError | WriterError> {
    const result = this.tx.write(address, value);
    logResult("write", result, address, value);
    return result;
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): void {
    const writeResult = this.tx.write(address, value);
    logResult("writeOrThrow, initial", writeResult, address, value);
    if (
      writeResult.error &&
      (writeResult.error.name === "NotFoundError")
    ) {
      // Create parent entries if needed.
      // errorPath includes the missing key (consistent with read errors).
      // lastExistingPath is one level up - the actual last existing parent.
      const errorPath = (writeResult.error as INotFoundError).path;
      const lastExistingPath = errorPath.slice(0, -1);
      // When document doesn't exist (errorPath is []), we don't need to read -
      // just start with {}. But if errorPath has content (e.g., ["foo"]), the
      // document exists and we need to read from lastExistingPath to preserve
      // existing fields.
      let valueObj: Record<string, JSONValue>;
      if (errorPath.length === 0) {
        valueObj = {};
      } else {
        const currentValue = this.readOrThrow({
          ...address,
          path: lastExistingPath,
        }, { meta: ignoreReadForScheduling });
        if (!isRecord(currentValue)) {
          // This should have already been caught as type mismatch error
          throw new Error(
            `Value at path ${address.path.join("/")} is not an object`,
          );
        }
        valueObj = currentValue as Record<string, JSONValue>;
      }
      const remainingPath = address.path.slice(lastExistingPath.length);
      if (remainingPath.length === 0) {
        throw new Error(
          `Invalid error path: ${errorPath.join("/")}`,
        );
      }
      const lastKey = remainingPath.pop()!;
      let nextValue: Record<string, JSONValue> = valueObj;
      // Create intermediate containers. The container type depends on whether
      // the NEXT key (the one that will access this container) is a valid array
      // index.
      for (let i = 0; i < remainingPath.length; i++) {
        const key = remainingPath[i];
        const nextKey = remainingPath[i + 1] ?? lastKey;
        const isNextKeyArrayIndex = isArrayIndexPropertyName(nextKey);
        nextValue =
          nextValue[key] =
            (isNextKeyArrayIndex ? [] : {}) as Record<string, JSONValue>;
      }
      nextValue[lastKey] = value as JSONValue;
      const parentAddress = { ...address, path: lastExistingPath };
      const writeResultRetry = this.tx.write(parentAddress, valueObj);
      logResult(
        "writeOrThrow, retry",
        writeResultRetry,
        parentAddress,
        valueObj,
      );
      if (writeResultRetry.error) {
        throw toThrowable(writeResultRetry.error);
      }
    } else if (writeResult.error) {
      throw toThrowable(writeResult.error);
    }
  }

  writeValueOrThrow(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): void {
    this.writeOrThrow({ ...address, path: ["value", ...address.path] }, value);
  }

  abort(reason?: any): Result<any, InactiveTransactionError> {
    return this.tx.abort(reason);
  }

  commit(): Promise<Result<Unit, CommitError>> {
    const promise = this.tx.commit();

    // Call commit callbacks after commit completes (success or failure) Note
    // that promise always resolves, even if the commit fails, in which case it
    // passes an error message as result. An exception here would be an internal
    // error that should propagate.
    promise.then((_result) => {
      // Call all callbacks, wrapping each in try/catch to prevent one
      // failing callback from breaking others
      for (const callback of this.commitCallbacks) {
        try {
          callback(this);
        } catch (error) {
          logger.error("storage-error", "Error in commit callback:", error);
        }
      }
    });

    return promise;
  }

  /**
   * Add a callback to be called when the transaction commit completes.
   * The callback receives the transaction as a parameter and is called
   * regardless of whether the commit succeeded or failed.
   *
   * Note: Callbacks are called synchronously after commit completes.
   * If a callback throws, the error is logged but doesn't affect other callbacks.
   *
   * @param callback - Function to call after commit
   */
  addCommitCallback(callback: (tx: IExtendedStorageTransaction) => void): void {
    this.commitCallbacks.add(callback);
  }
}

/**
 * Options for configuring a TransactionWrapper.
 */
export interface TransactionWrapperOptions {
  /**
   * If true, adds ignoreReadForScheduling meta to all reads, making them
   * non-reactive.
   */
  nonReactive?: boolean;

  /**
   * Transaction to use for creating child cells. If not provided, uses the
   * wrapped transaction.
   */
  childCellTx?: IExtendedStorageTransaction;
}

/**
 * A configurable wrapper around an IExtendedStorageTransaction.
 *
 * Supports two modes that can be combined:
 * - nonReactive: Adds ignoreReadForScheduling meta to all reads
 * - childCellTx: Uses a different transaction for child cells
 *
 * Used by:
 * - Cell.sample(): nonReactive=true, childCellTx=wrapped (child cells reactive)
 * - Cell.sink(): nonReactive=false, childCellTx=extraTx (child cells on separate tx)
 */
export class TransactionWrapper implements IExtendedStorageTransaction {
  constructor(
    private wrapped: IExtendedStorageTransaction,
    private options: TransactionWrapperOptions = {},
  ) {}

  /**
   * Get the transaction to use for creating child cells.
   */
  getTransactionForChildCells(): IExtendedStorageTransaction {
    return this.options.childCellTx ?? this.wrapped;
  }

  get tx(): IStorageTransaction {
    return this.wrapped.tx;
  }

  get journal(): ITransactionJournal {
    return this.wrapped.journal;
  }

  status(): StorageTransactionStatus {
    return this.wrapped.status();
  }

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    return this.wrapped.reader(space);
  }

  private transformReadOptions(options?: IReadOptions): IReadOptions {
    if (!this.options.nonReactive) {
      return options ?? {};
    }
    return {
      ...options,
      meta: { ...options?.meta, ...ignoreReadForScheduling },
    };
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, ReadError> {
    return this.wrapped.read(address, this.transformReadOptions(options));
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): JSONValue | undefined {
    return this.wrapped.readOrThrow(
      address,
      this.transformReadOptions(options),
    );
  }

  readValueOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): JSONValue | undefined {
    return this.wrapped.readValueOrThrow(
      address,
      this.transformReadOptions(options),
    );
  }

  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
    return this.wrapped.writer(space);
  }

  write(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): Result<IAttestation, WriteError | WriterError> {
    return this.wrapped.write(address, value);
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): void {
    return this.wrapped.writeOrThrow(address, value);
  }

  writeValueOrThrow(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): void {
    return this.wrapped.writeValueOrThrow(address, value);
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    return this.wrapped.abort(reason);
  }

  commit(): Promise<Result<Unit, CommitError>> {
    return this.wrapped.commit();
  }

  addCommitCallback(callback: (tx: IExtendedStorageTransaction) => void): void {
    return this.wrapped.addCommitCallback(callback);
  }
}

/**
 * Create a non-reactive transaction wrapper for Cell.sample().
 * Reads won't trigger re-execution, but child cells will be reactive.
 */
export function createNonReactiveTransaction(
  tx: IExtendedStorageTransaction,
): TransactionWrapper {
  return new TransactionWrapper(tx, { nonReactive: true, childCellTx: tx });
}

/**
 * Create a transaction wrapper for Cell.sink() that uses a separate transaction
 * for child cells.
 */
export function createChildCellTransaction(
  tx: IExtendedStorageTransaction,
  childCellTx: IExtendedStorageTransaction,
): TransactionWrapper {
  return new TransactionWrapper(tx, { childCellTx });
}

/**
 * Helper function to get the transaction to use for creating child cells from a
 * potentially wrapped transaction. If the transaction is not wrapped, returns
 * it as-is.
 *
 * Used when creating child cells that should use a different transaction than
 * the parent read (e.g., in Cell.sample() or Cell.sink()).
 */
export function getTransactionForChildCells(
  tx: IExtendedStorageTransaction | undefined,
): IExtendedStorageTransaction | undefined {
  if (tx instanceof TransactionWrapper) {
    return tx.getTransactionForChildCells();
  }
  return tx;
}

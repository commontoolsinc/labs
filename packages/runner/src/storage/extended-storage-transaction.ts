import { isRecord } from "@commontools/utils/types";
import { getLogger } from "@commontools/utils/logger";
import type {
  CommitError,
  IAttestation,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  InactiveTransactionError,
  IReadOptions,
  IStorageTransaction,
  ITransactionJournal,
  ITransactionReader,
  ITransactionWriter,
  JSONValue,
  MemorySpace,
  ReaderError,
  ReadError,
  Result,
  StorageTransactionStatus,
  Unit,
  WriteError,
  WriterError,
} from "./interface.ts";

import { ignoreReadForScheduling } from "../scheduler.ts";

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
    logger.error(`${kind} Error`, result.error, ...args);
  } else {
    logger.info(`${kind} Success`, result.ok, ...args);
  }
};

export class ExtendedStorageTransaction implements IExtendedStorageTransaction {
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
      throw readResult.error;
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
      // Create parent entries if needed
      const lastValidPath = writeResult.error.name === "NotFoundError"
        ? writeResult.error.path
        : undefined;
      const currentValue = this.readValueOrThrow({
        ...address,
        path: lastValidPath ?? [],
      }, { meta: ignoreReadForScheduling });
      const valueObj = lastValidPath === undefined ? {} : currentValue;
      if (!isRecord(valueObj)) {
        // This should have already been caught as type mismatch error
        throw new Error(
          `Value at path ${address.path.join("/")} is not an object`,
        );
      }
      const remainingPath = address.path.slice(lastValidPath?.length ?? 0);
      if (remainingPath.length === 0) {
        throw new Error(
          `Invalid error path: ${lastValidPath?.join("/")}`,
        );
      }
      const lastKey = remainingPath.pop()!;
      let nextValue = valueObj;
      for (const key of remainingPath) {
        nextValue =
          nextValue[key] =
            (Number.isInteger(Number(key)) ? [] : {}) as typeof nextValue;
      }
      nextValue[lastKey] = value;
      const parentAddress = { ...address, path: lastValidPath ?? [] };
      const writeResultRetry = this.tx.write(parentAddress, valueObj);
      logResult(
        "writeOrThrow, retry",
        writeResultRetry,
        parentAddress,
        valueObj,
      );
      if (writeResultRetry.error) {
        throw writeResultRetry.error;
      }
    } else if (writeResult.error) {
      throw writeResult.error;
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
    return this.tx.commit();
  }
}

import { isObject, isRecord } from "@commontools/utils/types";
import type {
  CommitError,
  IExtendedStorageTransaction,
  IInvalidDataURIError,
  IMemorySpaceAddress,
  InactiveTransactionError,
  INotFoundError,
  IReadOptions,
  IStorageInvariant,
  IStorageTransaction,
  IStorageTransactionComplete,
  IStorageTransactionInconsistent,
  IStorageTransactionInvariant,
  IStorageTransactionLog,
  IStorageTransactionProgress,
  ITransactionReader,
  ITransactionWriter,
  IUnsupportedMediaTypeError,
  JSONValue,
  MemoryAddressPathComponent,
  MemorySpace,
  Read,
  ReaderError,
  ReadError,
  Result,
  StorageTransactionFailed,
  Unit,
  Write,
  WriteError,
  WriterError,
} from "./interface.ts";
import type { IRuntime } from "../runtime.ts";
import type { EntityId } from "../doc-map.ts";
import { getValueAtPath } from "../path-utils.ts";
import { getJSONFromDataURI } from "../uri-utils.ts";

/**
 * Convert a URI string to an EntityId object
 */
export function uriToEntityId(uri: string): EntityId {
  if (!uri.startsWith("of:")) {
    throw new Error(`Invalid URI: ${uri}`);
  }
  return { "/": uri.slice(3) };
}

/**
 * Validate that the parent path exists and is a record for nested writes
 */
function validateParentPath(
  value: any,
  path: readonly MemoryAddressPathComponent[],
): INotFoundError | null {
  const pathLength = path.length;

  if (pathLength === 0) {
    return null; // Root write, no validation needed
  }

  // Check if the document itself exists and is an object for first-level writes
  if (pathLength === 1) {
    if (value === undefined || !isRecord(value)) {
      const pathError: INotFoundError = new Error(
        `Cannot access path [${String(path[0])}] - document is not a record`,
      ) as INotFoundError;
      pathError.name = "NotFoundError";
      return pathError;
    }
    return null;
  }

  // For deeper paths, check that the parent path exists and is an object
  const lastIndex = pathLength - 1;
  let parentValue = value;

  let parentIndex = 0;
  for (parentIndex = 0; parentIndex < lastIndex; parentIndex++) {
    if (!isRecord(parentValue)) {
      parentValue = undefined;
      break;
    }
    parentValue = parentValue[path[parentIndex] as keyof typeof parentValue];
  }

  if (
    value === undefined || parentValue === undefined || !isRecord(parentValue)
  ) {
    const pathError: INotFoundError = new Error(
      `Cannot access path [${path.join(", ")}] - parent path [${
        path.slice(0, lastIndex).join(", ")
      }] does not exist or is not a record`,
    ) as INotFoundError;
    pathError.name = "NotFoundError";

    // Set pathError.path to last valid parent path component
    if (parentIndex > 0) pathError.path = path.slice(0, parentIndex - 1);

    return pathError;
  }

  return null;
}

/**
 * Simple implementation of IStorageTransactionLog that tracks read/write operations
 */
class StorageTransactionLog implements IStorageTransactionLog {
  private log: IStorageTransactionInvariant[] = [];

  get(_address: IMemorySpaceAddress): IStorageTransactionInvariant {
    throw new Error("Not implemented");
  }

  addRead(read: IStorageInvariant): void {
    this.log.push({ read });
  }

  addWrite(write: IStorageInvariant): void {
    this.log.push({ write });
  }

  [Symbol.iterator](): Iterator<IStorageTransactionInvariant> {
    return this.log[Symbol.iterator]();
  }
}

/**
 * Implementation of ITransactionReader that reads from DocImpl documents
 */
class TransactionReader implements ITransactionReader {
  constructor(
    protected runtime: IRuntime,
    protected space: MemorySpace,
    protected log: StorageTransactionLog,
  ) {}

  did() {
    return this.space;
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<Read, ReadError> {
    if (address.type !== "application/json") {
      const error = new Error(
        "Unsupported media type",
      ) as IUnsupportedMediaTypeError;
      error.name = "UnsupportedMediaTypeError";
      return {
        ok: undefined,
        error,
      };
    }

    // If the address is a data URI, don't read from doc, just read the JSON
    // from the data URI and validate the path and return the value.
    if (address.id.startsWith("data:")) {
      try {
        const json = getJSONFromDataURI(address.id);

        const validationError = validateParentPath(json, address.path);
        if (validationError) {
          return { ok: undefined, error: validationError };
        }

        const value = getValueAtPath(json, address.path);

        const read: IStorageInvariant = {
          address,
          value,
        };
        this.log.addRead(read);

        return { ok: read };
      } catch (error) {
        const dataUriError = new Error(
          "Invalid data URI",
        ) as IInvalidDataURIError;
        dataUriError.name = "InvalidDataURIError";
        dataUriError.cause = error as Error;
        return {
          ok: undefined,
          error: dataUriError,
        };
      }
    }

    // Convert URI to EntityId
    const entityId = uriToEntityId(address.id);

    // Get the document from the runtime's document map
    const doc = this.runtime.documentMap.getDocByEntityId(
      address.space,
      entityId,
      false, // Don't create if not found
    );

    if (!doc) {
      const notFoundError: INotFoundError = new Error(
        `Document not found: ${address.id}`,
      ) as INotFoundError;
      notFoundError.name = "NotFoundError";
      return { ok: undefined, error: notFoundError };
    }

    // Path-based logic
    if (!address.path.length) {
      const notFoundError: INotFoundError = new Error(
        `Path must not be empty`,
      ) as INotFoundError;
      notFoundError.name = "NotFoundError";
      return { ok: undefined, error: notFoundError };
    }
    const [first, ...rest] = address.path;
    if (first === "value") {
      // Validate parent path exists and is a record for nested writes/reads
      const validationError = validateParentPath(doc.get(), rest);
      if (validationError) {
        return { ok: undefined, error: validationError };
      }
      // Read from doc itself
      const value = doc.getAtPath(rest);
      const read: IStorageInvariant = {
        address,
        value,
      };
      this.log.addRead(read);
      return { ok: read };
    } else if (first === "source") {
      // Only allow path length 1
      if (rest.length > 0) {
        const notFoundError: INotFoundError = new Error(
          `Path beyond 'source' is not allowed`,
        ) as INotFoundError;
        notFoundError.name = "NotFoundError";
        return { ok: undefined, error: notFoundError };
      }
      // Return the URI of the sourceCell if it exists
      const sourceCell = doc.sourceCell;
      let value: string | undefined = undefined;
      if (sourceCell) {
        // Convert EntityId to URI string
        value = `of:${JSON.parse(JSON.stringify(sourceCell.entityId))["/"]}`;
      }
      const read: IStorageInvariant = {
        address,
        value,
      };
      this.log.addRead(read);
      return { ok: read };
    } else {
      const notFoundError: INotFoundError = new Error(
        `Invalid first path element: ${String(first)}`,
      ) as INotFoundError;
      notFoundError.name = "NotFoundError";
      return { ok: undefined, error: notFoundError };
    }
  }
}

/**
 * Implementation of ITransactionWriter that writes to DocImpl documents
 */
class TransactionWriter extends TransactionReader
  implements ITransactionWriter {
  write(
    address: IMemorySpaceAddress,
    value?: any,
  ): Result<
    Write,
    | INotFoundError
    | InactiveTransactionError
    | IUnsupportedMediaTypeError
  > {
    if (address.type !== "application/json") {
      const error = new Error(
        "Unsupported media type",
      ) as IUnsupportedMediaTypeError;
      error.name = "UnsupportedMediaTypeError";
      return {
        ok: undefined,
        error,
      };
    }

    // If the address is a data URI, don't write to doc, just write the JSON
    // to the data URI and return the write.
    if (address.id.startsWith("data:")) {
      const error = new Error(
        "Cannot write to data URI",
      ) as IUnsupportedMediaTypeError;
      error.name = "UnsupportedMediaTypeError";
      return {
        ok: undefined,
        error,
      };
    }

    // Convert URI to EntityId
    const entityId = uriToEntityId(address.id);

    // Get or create the document from the runtime's document map
    const doc = this.runtime.documentMap.getDocByEntityId(
      address.space,
      entityId,
      true, // Create if not found
    );

    if (!doc) {
      throw new Error(`Failed to get or create document: ${address.id}`);
    }

    // Path-based logic
    if (!address.path.length) {
      const notFoundError: INotFoundError = new Error(
        `Path must not be empty`,
      ) as INotFoundError;
      notFoundError.name = "NotFoundError";
      return { ok: undefined, error: notFoundError };
    }
    const [first, ...rest] = address.path;
    if (first === "value") {
      // Validate parent path exists and is a record for nested writes
      const validationError = validateParentPath(doc.get(), rest);
      if (validationError) {
        return { ok: undefined, error: validationError };
      }
      // Write to doc itself
      doc.setAtPath(rest, value);
      const write: IStorageInvariant = {
        address,
        value,
      };
      this.log.addWrite(write);
      return { ok: write };
    } else if (first === "source") {
      // Only allow path length 1
      if (rest.length > 0) {
        const notFoundError: INotFoundError = new Error(
          `Path beyond 'source' is not allowed`,
        ) as INotFoundError;
        notFoundError.name = "NotFoundError";
        return { ok: undefined, error: notFoundError };
      }
      // Value must be a URI string (of:...)
      if (typeof value !== "string" || !value.startsWith("of:")) {
        const notFoundError: INotFoundError = new Error(
          `Value for 'source' must be a URI string (of:...)`,
        ) as INotFoundError;
        notFoundError.name = "NotFoundError";
        return { ok: undefined, error: notFoundError };
      }
      // Get the source doc in the same space
      const sourceEntityId = uriToEntityId(value);
      const sourceDoc = this.runtime.documentMap.getDocByEntityId(
        address.space,
        sourceEntityId,
        false,
      );
      if (!sourceDoc) {
        const notFoundError: INotFoundError = new Error(
          `Source document not found: ${value}`,
        ) as INotFoundError;
        notFoundError.name = "NotFoundError";
        return { ok: undefined, error: notFoundError };
      }
      doc.sourceCell = sourceDoc;
      const write: IStorageInvariant = {
        address,
        value,
      };
      this.log.addWrite(write);
      return { ok: write };
    } else {
      const notFoundError: INotFoundError = new Error(
        `Invalid first path element: ${String(first)}`,
      ) as INotFoundError;
      notFoundError.name = "NotFoundError";
      return { ok: undefined, error: notFoundError };
    }
  }
}

/**
 * Implementation of IStorageTransaction that uses DocImpl and runtime.documentMap
 */
export class StorageTransaction implements IStorageTransaction {
  private txLog = new StorageTransactionLog();
  private currentStatus: IStorageTransactionProgress = { open: this.txLog };
  private readers = new Map<string, ITransactionReader>();
  private writers = new Map<string, ITransactionWriter>();

  constructor(private runtime: IRuntime) {}

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    if (this.currentStatus.open === undefined) {
      const error = new Error(
        "Storage transaction complete",
      ) as IStorageTransactionComplete;
      error.name = "StorageTransactionCompleteError";
      return {
        ok: undefined,
        error,
      };
    }

    let reader = this.readers.get(space);
    if (!reader) {
      reader = new TransactionReader(this.runtime, space, this.txLog);
      this.readers.set(space, reader);
    }

    return { ok: reader };
  }

  read(address: IMemorySpaceAddress, options?: IReadOptions): Result<Read, ReadError> {
    const readerResult = this.reader(address.space);
    if (readerResult.error) {
      return { ok: undefined, error: readerResult.error };
    }

    const readResult = readerResult.ok!.read(address, options);
    if (readResult.error) {
      return { ok: undefined, error: readResult.error };
    }
    return { ok: readResult.ok };
  }

  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
    if (this.currentStatus.open === undefined) {
      const error = new Error(
        "Storage transaction complete",
      ) as IStorageTransactionComplete;
      error.name = "StorageTransactionCompleteError";
      return {
        ok: undefined,
        error,
      };
    }

    // Check if we already have a writer for a different space
    if (this.writers.size > 0 && !this.writers.has(space)) {
      const openSpace = Array.from(this.writers.keys())[0];
      const error: any = new Error(
        `Writer already open for space: ${openSpace}`,
      );
      error.name = "StorageTransactionWriteIsolationError";
      error.open = openSpace;
      error.requested = space;
      return { ok: undefined, error };
    }

    let writer = this.writers.get(space);
    if (!writer) {
      writer = new TransactionWriter(this.runtime, space, this.txLog);
      this.writers.set(space, writer);
    }

    return { ok: writer };
  }

  write(
    address: IMemorySpaceAddress,
    value: any,
  ): Result<Write, WriteError | WriterError> {
    const writerResult = this.writer(address.space);
    if (writerResult.error) {
      return { ok: undefined, error: writerResult.error };
    }

    const writeResult = writerResult.ok!.write(address, value);
    if (writeResult.error) {
      return { ok: undefined, error: writeResult.error as WriteError };
    }
    return { ok: writeResult.ok };
  }

  abort(reason?: any): Result<any, InactiveTransactionError> {
    if (this.currentStatus.open === undefined) {
      const error = new Error(
        "Storage transaction complete",
      ) as IStorageTransactionComplete;
      error.name = "StorageTransactionCompleteError";
      return {
        ok: undefined,
        error,
      };
    }

    // Set status to done with the current log to indicate the transaction is complete
    this.currentStatus = { done: this.txLog };
    return { ok: undefined };
  }

  commit(): Promise<Result<Unit, CommitError>> {
    if (this.currentStatus.open === undefined) {
      const error: any = new Error("Transaction already aborted");
      error.name = "StorageTransactionAborted";
      error.reason = "Transaction was aborted";
      return Promise.resolve({ ok: undefined, error });
    }

    // For now, just mark as done since we're only implementing basic read/write
    // In a real implementation, this would send the transaction to upstream storage
    this.currentStatus = { done: this.txLog };
    return Promise.resolve({ ok: {} });
  }
}

export class ExtendedStorageTransaction implements IExtendedStorageTransaction {
  constructor(private tx: IStorageTransaction) {}

  status(): Result<IStorageTransactionProgress, StorageTransactionFailed> {
    // If the underlying transaction has status, use it; otherwise, return a default
    // This assumes the underlying transaction is a StorageTransaction from this file
    // and has currentStatus and txLog, otherwise this will need to be adapted
    if (typeof (this.tx as any).currentStatus !== "undefined") {
      return { ok: (this.tx as any).currentStatus };
    }
    // Fallback: not available
    return { ok: { open: (this.tx as any).txLog } };
  }

  log(): IStorageTransactionLog {
    if (typeof (this.tx as any).txLog !== "undefined") {
      return (this.tx as any).txLog;
    }
    throw new Error("Underlying transaction does not expose log");
  }

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    return this.tx.reader(space);
  }

  read(address: IMemorySpaceAddress, options?: IReadOptions): Result<Read, ReadError> {
    return this.tx.read(address, options);
  }

  readOrThrow(address: IMemorySpaceAddress): JSONValue | undefined {
    const readResult = this.tx.read(address);
    if (readResult.error && readResult.error.name !== "NotFoundError") {
      throw readResult.error;
    }
    return readResult.ok?.value;
  }

  readValueOrThrow(address: IMemorySpaceAddress): JSONValue | undefined {
    return this.readOrThrow({ ...address, path: ["value", ...address.path] });
  }

  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
    return this.tx.writer(space);
  }

  write(
    address: IMemorySpaceAddress,
    value: any,
  ): Result<Write, WriteError | WriterError> {
    return this.tx.write(address, value);
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): void {
    const writeResult = this.tx.write(address, value);
    if (writeResult.error && writeResult.error.name === "NotFoundError") {
      // Create parent entries if needed
      const lastValidPath = writeResult.error.path;
      const valueObj = lastValidPath
        ? this.readValueOrThrow({ ...address, path: lastValidPath })
        : {};
      if (!isRecord(valueObj)) {
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
            (typeof Number(key) === "number" ? [] : {}) as typeof nextValue;
      }
      nextValue[lastKey] = value;
      const parentAddress = { ...address, path: lastValidPath ?? [] };
      const writeResultRetry = this.tx.write(parentAddress, valueObj);
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

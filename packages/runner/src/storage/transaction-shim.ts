import { refer } from "@commontools/memory/reference";
import { isRecord } from "@commontools/utils/types";
import type {
  IInvalidDataURIError,
  IMemoryAddress,
  InactiveTransactionError,
  INotFoundError,
  IReaderError,
  IStorageTransaction,
  IStorageTransactionComplete,
  IStorageTransactionError,
  IStorageTransactionInconsistent,
  IStorageTransactionInvariant,
  IStorageTransactionLog,
  IStorageTransactionProgress,
  ITransactionReader,
  ITransactionWriter,
  IUnsupportedMediaTypeError,
  IWriterError,
  MemoryAddressPathComponent,
  Read,
  Result,
  Write,
} from "./interface.ts";
import type { IRuntime } from "../runtime.ts";
import type { DocImpl } from "../doc.ts";
import type { EntityId } from "../doc-map.ts";
import { getValueAtPath } from "../path-utils.ts";
import { getJSONFromDataURI } from "../uri-utils.ts";

/**
 * Convert a URI string to an EntityId object
 */
function uriToEntityId(uri: string): EntityId {
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
  path: MemoryAddressPathComponent[],
): INotFoundError | null {
  if (path.length === 0) {
    return null; // Root write, no validation needed
  }

  // Check if the document itself exists and is a record for first-level writes
  if (path.length === 1) {
    if (value === undefined || !isRecord(value)) {
      const pathError: INotFoundError = new Error(
        `Cannot write to path [${String(path[0])}] - document is not a record`,
      ) as INotFoundError;
      pathError.name = "NotFoundError";
      return pathError;
    }
    return null;
  }

  // For deeper paths, check that the parent path exists and is a record
  const parentPath = path.slice(0, -1);

  const parentValue = getValueAtPath(value, parentPath);

  if (parentValue === undefined || !isRecord(parentValue)) {
    const pathError: INotFoundError = new Error(
      `Cannot write to path [${
        path.map((p) => String(p)).join(", ")
      }] - parent path [${
        parentPath.map((p) => String(p)).join(", ")
      }] does not exist or is not a record`,
    ) as INotFoundError;
    pathError.name = "NotFoundError";

    // Set pathError.path to last valid parent path component
    pathError.path = [];
    while (parentPath.length > 0) {
      const segment = parentPath.shift()!;
      value = value[segment];
      if (!isRecord(value)) break;
      pathError.path.push(segment);
    }

    return pathError;
  }

  return null;
}

/**
 * Simple implementation of IStorageTransactionLog that tracks read/write operations
 */
class StorageTransactionLog implements IStorageTransactionLog {
  private log: IStorageTransactionInvariant[] = [];

  get(_address: IMemoryAddress): IStorageTransactionInvariant {
    throw new Error("Not implemented");
  }

  addRead(read: Read): void {
    this.log.push({ read });
  }

  addWrite(write: Write): void {
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
    protected log: StorageTransactionLog,
  ) {}

  read(
    address: IMemoryAddress,
  ): Result<Read, IReaderError> {
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

        const read: Read = {
          address,
          value,
          cause: refer("shim does not care"),
        };
        this.log.addRead(read);

        return { ok: read };
      } catch (error) {
        const dataUriError = new Error(
          "Invalid data URI",
        ) as IInvalidDataURIError;
        dataUriError.name = "InvalidDataURIError";
        dataUriError.cause = error;
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

    const validationError = validateParentPath(doc.get(), address.path);
    if (validationError) {
      return { ok: undefined, error: validationError };
    }

    // Read the value at the specified path
    const value = getValueAtPath(doc.get(), address.path);

    // Create the read invariant
    const read: Read = {
      address,
      value,
      cause: refer("shim does not care"),
    };
    this.log.addRead(read);

    return { ok: read };
  }
}

/**
 * Implementation of ITransactionWriter that writes to DocImpl documents
 */
class TransactionWriter extends TransactionReader
  implements ITransactionWriter {
  write(
    address: IMemoryAddress,
    value?: any,
  ): Result<
    Write,
    | INotFoundError
    | InactiveTransactionError
    | IUnsupportedMediaTypeError
    | IInvalidDataURIError
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

    // For non-empty paths, check if document exists and is a record
    if (address.path.length > 0) {
      if (doc.get() === undefined || !isRecord(doc.get())) {
        const notFoundError: INotFoundError = new Error(
          `Document not found or not a record: ${address.id}`,
        ) as INotFoundError;
        notFoundError.name = "NotFoundError";
        return { ok: undefined, error: notFoundError };
      }
    }

    // Validate parent path exists and is a record for nested writes
    const validationError = validateParentPath(doc.get(), address.path);
    if (validationError) {
      return { ok: undefined, error: validationError };
    }

    // Write the value at the specified path
    doc.setAtPath(address.path, value);

    // Create the write invariant
    const write: Write = {
      address,
      value,
      cause: refer(address.id),
    };
    this.log.addWrite(write);

    return { ok: write };
  }
}

/**
 * Implementation of IStorageTransaction that uses DocImpl and runtime.documentMap
 */
export class StorageTransaction implements IStorageTransaction {
  private log = new StorageTransactionLog();
  private currentStatus: IStorageTransactionProgress = { open: this.log };
  private readers = new Map<string, ITransactionReader>();
  private writers = new Map<string, ITransactionWriter>();

  constructor(private runtime: IRuntime) {}

  status(): Result<IStorageTransactionProgress, IStorageTransactionError> {
    return { ok: this.currentStatus };
  }

  reader(space: string): Result<ITransactionReader, IReaderError> {
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
      reader = new TransactionReader(this.runtime, this.log);
      this.readers.set(space, reader);
    }

    return { ok: reader };
  }

  read(address: IMemoryAddress): Result<Read, IReaderError> {
    const readerResult = this.reader(address.space);
    if (readerResult.error) {
      return { ok: undefined, error: readerResult.error };
    }

    const readResult = readerResult.ok!.read(address);
    if (readResult.error) {
      return { ok: undefined, error: readResult.error as IReaderError };
    }
    return { ok: readResult.ok };
  }

  writer(space: string): Result<ITransactionWriter, IWriterError> {
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
      writer = new TransactionWriter(this.runtime, this.log);
      this.writers.set(space, writer);
    }

    return { ok: writer };
  }

  write(address: IMemoryAddress, value: any): Result<Write, IWriterError> {
    const writerResult = this.writer(address.space);
    if (writerResult.error) {
      return { ok: undefined, error: writerResult.error };
    }

    const writeResult = writerResult.ok!.write(address, value);
    if (writeResult.error) {
      return { ok: undefined, error: writeResult.error as IWriterError };
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
    this.currentStatus = { done: this.log };
    return { ok: undefined };
  }

  commit(): Promise<Result<any, IStorageTransactionError>> {
    if (this.currentStatus.open === undefined) {
      const error: any = new Error("Transaction already aborted");
      error.name = "StorageTransactionAborted";
      error.reason = "Transaction was aborted";
      return Promise.resolve({ ok: undefined, error });
    }

    // For now, just mark as done since we're only implementing basic read/write
    // In a real implementation, this would send the transaction to upstream storage
    this.currentStatus = { done: this.log };
    return Promise.resolve({ ok: undefined });
  }
}

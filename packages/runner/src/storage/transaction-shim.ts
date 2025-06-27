import type {
  IMemoryAddress,
  InactiveTransactionError,
  INotFoundError,
  IReaderError,
  IStorageTransaction,
  IStorageTransactionError,
  IStorageTransactionInconsistent,
  IStorageTransactionInvariant,
  IStorageTransactionLog,
  IStorageTransactionProgress,
  ITransactionReader,
  ITransactionWriter,
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
import { refer } from "@commontools/memory/reference";
import { isRecord } from "@commontools/utils/types";

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
  doc: DocImpl<any>,
  path: MemoryAddressPathComponent[],
): INotFoundError | null {
  if (path.length === 0) {
    return null; // Root write, no validation needed
  }

  // Check if the document itself exists and is a record for first-level writes
  if (path.length === 1) {
    if (doc.get() === undefined || !isRecord(doc.get())) {
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

  const parentValue = getValueAtPath(doc.get(), parentPath);

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
    let value = doc.get();
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

  get(address: IMemoryAddress): IStorageTransactionInvariant {
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

    const validationError = validateParentPath(doc, address.path);
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
  ): Result<Write, INotFoundError | InactiveTransactionError> {
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
    const validationError = validateParentPath(doc, address.path);
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
      return {
        ok: undefined,
        error: { name: "StorageTransactionCompleteError" } as any,
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
      return {
        ok: undefined,
        error: { name: "StorageTransactionCompleteError" } as any,
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
      return {
        ok: undefined,
        error: { name: "StorageTransactionCompleteError" } as any,
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

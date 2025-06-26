import type {
  IMemoryAddress,
  InactiveTransactionError,
  IReaderError,
  IStorageTransaction,
  IStorageTransactionError,
  IStorageTransactionInconsistent,
  IStorageTransactionInvariant,
  IStorageTransactionLog,
  IStorageTransactionNotFound,
  IStorageTransactionProgress,
  IStorageTransactionWritePathError,
  ITransactionReader,
  ITransactionWriter,
  IWriterError,
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
  return { "/": uri };
}

/**
 * Validate that the parent path exists and is a record for nested writes
 */
function validateParentPath(
  doc: DocImpl<any>,
  path: PropertyKey[],
): IStorageTransactionWritePathError | null {
  if (path.length === 0) {
    return null; // Root write, no validation needed
  }

  // Check if the document itself exists and is a record for first-level writes
  if (path.length === 1) {
    if (doc.value === undefined || !isRecord(doc.value)) {
      const pathError: IStorageTransactionWritePathError = new Error(
        `Cannot write to path [${String(path[0])}] - document is not a record`,
      ) as IStorageTransactionWritePathError;
      pathError.name = "StorageTransactionWritePathError";
      pathError.path = path.map((p) => String(p));
      return pathError;
    }
    return null;
  }

  // For deeper paths, check that the parent path exists and is a record
  const parentPath = path.slice(0, -1);
  const parentValue = getValueAtPath(doc.value, parentPath);

  if (parentValue === undefined || !isRecord(parentValue)) {
    const pathError: IStorageTransactionWritePathError = new Error(
      `Cannot write to path [${
        path.map((p) => String(p)).join(", ")
      }] - parent path [${
        parentPath.map((p) => String(p)).join(", ")
      }] does not exist or is not a record`,
    ) as IStorageTransactionWritePathError;
    pathError.name = "StorageTransactionWritePathError";
    pathError.path = path.map((p) => String(p));
    pathError.parentPath = parentPath.map((p) => String(p));
    return pathError;
  }

  return null;
}

/**
 * Simple implementation of IStorageTransactionLog that tracks read/write operations
 */
class StorageTransactionLog implements IStorageTransactionLog {
  private invariants = new Map<string, IStorageTransactionInvariant>();

  get(address: IMemoryAddress): IStorageTransactionInvariant {
    const key = this.addressToKey(address);
    return this.invariants.get(key)!;
  }

  private addressToKey(address: IMemoryAddress): string {
    return `${address.space}/${address.id}/${address.type}/${
      JSON.stringify(address.path)
    }`;
  }

  addRead(read: Read): void {
    const key = this.addressToKey(read.address);
    this.invariants.set(key, { read });
  }

  addWrite(write: Write): void {
    const key = this.addressToKey(write.address);
    this.invariants.set(key, { write });
  }

  [Symbol.iterator](): Iterator<IStorageTransactionInvariant> {
    return this.invariants.values();
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

    // Read the value at the specified path
    const value = doc ? getValueAtPath(doc.value, address.path) : undefined;

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
  ): Result<Write, IWriterError> {
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
      if (doc.value === undefined || !isRecord(doc.value)) {
        const notFoundError: IStorageTransactionNotFound = new Error(
          `Document not found or not a record: ${address.id}`,
        ) as IStorageTransactionNotFound;
        notFoundError.name = "StorageTransactionNotFound";
        return { ok: undefined, error: notFoundError };
      }
    }

    // Validate parent path exists and is a record for nested writes
    const validationError = validateParentPath(doc, address.path);
    if (validationError) {
      return { ok: undefined, error: validationError };
    }

    // Write the value at the specified path
    const changed = doc.setAtPath(address.path, value);

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

  async commit(): Promise<Result<any, IStorageTransactionError>> {
    if (this.currentStatus.open === undefined) {
      const error: any = new Error("Transaction already aborted");
      error.name = "StorageTransactionAborted";
      error.reason = "Transaction was aborted";
      return { ok: undefined, error };
    }

    // For now, just mark as done since we're only implementing basic read/write
    // In a real implementation, this would send the transaction to upstream storage
    this.currentStatus = { done: this.log };
    return { ok: undefined };
  }
}

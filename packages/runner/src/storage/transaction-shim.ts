import { isObject, isRecord } from "@commontools/utils/types";
import type {
  Activity,
  CommitError,
  IAttestation,
  IExtendedStorageTransaction,
  IInvalidDataURIError,
  IMemorySpaceAddress,
  InactiveTransactionError,
  INotFoundError,
  IReadActivity,
  IReadOptions,
  IStorageTransaction,
  IStorageTransactionComplete,
  IStorageTransactionInconsistent,
  ITransactionJournal,
  ITransactionReader,
  ITransactionWriter,
  IUnsupportedMediaTypeError,
  JSONValue,
  MemoryAddressPathComponent,
  MemorySpace,
  Metadata,
  Read,
  ReaderError,
  ReadError,
  Result,
  StorageTransactionFailed,
  StorageTransactionStatus,
  Unit,
  Write,
  WriteError,
  WriterError,
} from "./interface.ts";
import type { IRuntime } from "../runtime.ts";
import type { EntityId } from "../doc-map.ts";
import { getValueAtPath } from "../path-utils.ts";
import { getJSONFromDataURI } from "../uri-utils.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";

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
 * Simple implementation of ITransactionJournal for tracking read/write operations
 */
class TransactionJournal implements ITransactionJournal {
  #activity: Activity[] = [];

  addRead(address: IMemorySpaceAddress, options?: IReadOptions): void {
    const readActivity: IReadActivity = {
      ...address,
      meta: options?.meta ?? {},
    };
    this.#activity.push({ read: readActivity });
  }

  addWrite(address: IMemorySpaceAddress): void {
    this.#activity.push({ write: address });
  }

  // ITransactionJournal implementation
  activity(): Iterable<Activity> {
    return this.#activity;
  }

  *novelty(space: MemorySpace): Iterable<IAttestation> {
    for (const activity of this.#activity) {
      if (activity.write) {
        if (activity.write.space === space) {
          yield {
            address: {
              id: activity.write.id,
              type: activity.write.type,
              path: activity.write.path,
            },
            value: undefined, // Value not available in activity log
          };
        }
      }
    }
  }

  *history(space: MemorySpace): Iterable<IAttestation> {
    for (const activity of this.#activity) {
      if (activity.read) {
        if (activity.read.space === space) {
          yield {
            address: {
              id: activity.read.id,
              type: activity.read.type,
              path: activity.read.path,
            },
            value: undefined, // Value not available in activity log
          };
        }
      }
    }
  }
}

/**
 * Implementation of ITransactionReader that reads from DocImpl documents
 */
class TransactionReader implements ITransactionReader {
  constructor(
    protected runtime: IRuntime,
    protected space: MemorySpace,
    protected journal: TransactionJournal,
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

        const read: Read = {
          address,
          value,
        };
        this.journal.addRead(address, options);

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
      console.error("Path must not be empty for address:", address);
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
      const read: Read = {
        address,
        value,
      };
      this.journal.addRead(address, options);
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
      const read: Read = {
        address,
        value,
      };
      this.journal.addRead(address, options);
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

    if (!address.path.length) {
      console.error("Path must not be empty for address:", address);
      console.error("Value: ", value);
      console.error("value is object:", isObject(value));
      console.error("'value' in value:", "value" in value);
      console.error("value.value:", value?.value);
    }

    // Rewrite creating new documents as setting the value
    if (address.path.length === 0 && isObject(value) && "value" in value) {
      address = { ...address, path: ["value"] };
      value = value.value;
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
      const write: Write = {
        address,
        value,
      };
      this.journal.addWrite(address);
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
      const write: Write = {
        address,
        value,
      };
      this.journal.addWrite(address);
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
  journal = new TransactionJournal();
  private currentStatus: StorageTransactionStatus;
  private readers = new Map<string, ITransactionReader>();
  private writers = new Map<string, ITransactionWriter>();

  constructor(private runtime: IRuntime) {
    this.currentStatus = { status: "ready", journal: this.journal };
  }

  status(): StorageTransactionStatus {
    return this.currentStatus;
  }

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    if (this.currentStatus.status !== "ready") {
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
      reader = new TransactionReader(this.runtime, space, this.journal);
      this.readers.set(space, reader);
    }

    return { ok: reader };
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<Read, ReadError> {
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
    if (this.currentStatus.status !== "ready") {
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
      writer = new TransactionWriter(this.runtime, space, this.journal);
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
    if (this.currentStatus.status !== "ready") {
      const error = new Error(
        "Storage transaction complete",
      ) as IStorageTransactionComplete;
      error.name = "StorageTransactionCompleteError";
      return {
        ok: undefined,
        error,
      };
    }

    // Set status to done with the current journal to indicate the transaction is complete
    this.currentStatus = {
      status: "done",
      journal: this.currentStatus.journal,
    };
    return { ok: undefined };
  }

  commit(): Promise<Result<Unit, CommitError>> {
    if (this.currentStatus.status !== "ready") {
      const error: any = new Error("Transaction already aborted");
      error.name = "StorageTransactionAborted";
      error.reason = "Transaction was aborted";
      return Promise.resolve({ ok: undefined, error });
    }

    // For now, just mark as done since we're only implementing basic read/write
    // In a real implementation, this would send the transaction to upstream storage
    this.currentStatus = {
      status: "done",
      journal: this.currentStatus.journal,
    };
    return Promise.resolve({ ok: {} });
  }
}

export class ExtendedStorageTransaction implements IExtendedStorageTransaction {
  constructor(private tx: IStorageTransaction) {}

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
  ): Result<Read, ReadError> {
    return this.tx.read(address, options);
  }

  readOrThrow(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): JSONValue | undefined {
    const readResult = this.tx.read(address, options);
    if (readResult.error && readResult.error.name !== "NotFoundError") {
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
  ): Result<Write, WriteError | WriterError> {
    return this.tx.write(address, value);
  }

  writeOrThrow(
    address: IMemorySpaceAddress,
    value: JSONValue | undefined,
  ): void {
    const writeResult = this.tx.write(address, value);
    if (writeResult.error && writeResult.error.name === "NotFoundError") {
      console.log("[writeOrThrow] NotFoundError retry logic");
      console.log("[writeOrThrow] address:", address);
      console.log("[writeOrThrow] value:", value);
      console.log("[writeOrThrow] error.path:", writeResult.error.path);
      
      // Create parent entries if needed
      const lastValidPath = writeResult.error.path;
      const valueObj = lastValidPath
        ? this.readValueOrThrow({ ...address, path: lastValidPath }, {
          meta: ignoreReadForScheduling,
        })
        : {};
      console.log("[writeOrThrow] valueObj after read:", valueObj);
      
      if (!isRecord(valueObj)) {
        throw new Error(
          `Value at path ${address.path.join("/")} is not an object`,
        );
      }
      const remainingPath = address.path.slice(lastValidPath?.length ?? 0);
      console.log("[writeOrThrow] remainingPath:", remainingPath);
      
      if (remainingPath.length === 0) {
        throw new Error(
          `Invalid error path: ${lastValidPath?.join("/")}`,
        );
      }
      const lastKey = remainingPath.pop()!;
      console.log("[writeOrThrow] lastKey:", lastKey);
      
      let nextValue = valueObj;
      for (const key of remainingPath) {
        console.log("[writeOrThrow] Creating structure for key:", key);
        console.log("[writeOrThrow] typeof Number(key):", typeof Number(key));
        console.log("[writeOrThrow] Number.isNaN(Number(key)):", Number.isNaN(Number(key)));
        nextValue =
          nextValue[key] =
            (Number.isInteger(Number(key)) ? [] : {}) as typeof nextValue;
      }
      nextValue[lastKey] = value;
      console.log("[writeOrThrow] Final valueObj to write:", valueObj);
      
      const parentAddress = { ...address, path: lastValidPath ?? [] };
      console.log("[writeOrThrow] parentAddress:", parentAddress);
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
    console.log("[writeValueOrThrow] Input address:", address);
    console.log("[writeValueOrThrow] Input path:", address.path);
    console.log("[writeValueOrThrow] Input value:", value);
    console.log("[writeValueOrThrow] Transformed path:", ["value", ...address.path]);
    this.writeOrThrow({ ...address, path: ["value", ...address.path] }, value);
  }

  abort(reason?: any): Result<any, InactiveTransactionError> {
    return this.tx.abort(reason);
  }

  commit(): Promise<Result<Unit, CommitError>> {
    return this.tx.commit();
  }
}

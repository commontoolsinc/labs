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
  IStorageSubscription,
  IStorageSubscriptionCapability,
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
  StorageNotification,
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
 * NotFoundError implementation for transaction-shim
 */
class NotFoundError extends RangeError implements INotFoundError {
  override readonly name = "NotFoundError" as const;
  public readonly source: IAttestation;
  public readonly address: IMemorySpaceAddress;
  private readonly space?: MemorySpace;

  constructor(
    message: string,
    id: string,
    path: readonly MemoryAddressPathComponent[] = [],
    value?: JSONValue,
    space?: MemorySpace,
  ) {
    super(message);
    this.space = space;
    // Ensure id has a valid URI format for type compatibility
    const uri = id.includes(":") ? id as `${string}:${string}` : `of:${id}` as `${string}:${string}`;
    this.address = {
      id: uri,
      type: "application/json",
      path: [...path], // Convert readonly to mutable array
      space: space || "" as MemorySpace,
    };
    this.source = {
      address: {
        id: uri,
        type: "application/json",
        path: [],
      },
      value,
    };
  }

  /**
   * @deprecated Use `address.path` instead. This property exists for backward compatibility.
   */
  get path(): MemoryAddressPathComponent[] {
    return [...this.address.path];
  }

  from(space: MemorySpace): INotFoundError {
    return new NotFoundError(
      this.message,
      this.address.id,
      [...this.address.path], // Convert to mutable array
      this.source.value,
      space,
    );
  }
}

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
  id: string,
): INotFoundError | null {
  const pathLength = path.length;

  if (pathLength === 0) {
    return null; // Root write, no validation needed
  }

  // Check if the document itself exists and is an object for first-level writes
  if (pathLength === 1) {
    if (value === undefined || !isRecord(value)) {
      return new NotFoundError(
        `Cannot access path [${String(path[0])}] - document is not a record`,
        id,
        [...path],
        value,
      );
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
    const errorPath = (parentIndex > 0) ? path.slice(0, parentIndex - 1) : [];
    return new NotFoundError(
      `Cannot access path [${path.join(", ")}] - parent path [${
        path.slice(0, lastIndex).join(", ")
      }] does not exist or is not a record`,
      id,
      errorPath,
      value,
    );
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

        const validationError = validateParentPath(json, address.path, address.id);
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
      const notFoundError = new NotFoundError(
        `Document not found: ${address.id}`,
        address.id,
        [],
        undefined,
        address.space,
      );
      return { ok: undefined, error: notFoundError };
    }

    // Path-based logic
    if (!address.path.length) {
      const notFoundError = new NotFoundError(
        `Path must not be empty`,
        address.id,
        [],
        undefined,
        address.space,
      );
      return { ok: undefined, error: notFoundError };
    }
    const [first, ...rest] = address.path;
    if (first === "value") {
      // Validate parent path exists and is a record for nested writes/reads
      const validationError = validateParentPath(doc.get(), rest, address.id);
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
        const notFoundError = new NotFoundError(
          `Path beyond 'source' is not allowed`,
          address.id,
          [...address.path],
          undefined,
          address.space,
        );
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
      const notFoundError = new NotFoundError(
        `Invalid first path element: ${String(first)}`,
        address.id,
        [...address.path],
        undefined,
        address.space,
      );
      return { ok: undefined, error: notFoundError };
    }
  }
}

/**
 * Implementation of ITransactionWriter that writes to DocImpl documents
 */
class TransactionWriter extends TransactionReader
  implements ITransactionWriter {
  constructor(
    runtime: IRuntime,
    space: MemorySpace,
    journal: TransactionJournal,
    private transaction: IStorageTransaction,
  ) {
    super(runtime, space, journal);
  }
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

    // Rewrite creating new documents as setting the value
    if (address.path.length === 0 && isObject(value) && "value" in value) {
      address = { ...address, path: ["value"] };
      value = value.value;
    }

    // Path-based logic
    if (!address.path.length) {
      const notFoundError = new NotFoundError(
        `Path must not be empty`,
        address.id,
        [],
        undefined,
        address.space,
      );
      return { ok: undefined, error: notFoundError };
    }
    const [first, ...rest] = address.path;
    if (first === "value") {
      // Validate parent path exists and is a record for nested writes
      const validationError = validateParentPath(doc.get(), rest, address.id);
      if (validationError) {
        return { ok: undefined, error: validationError };
      }
      // Write to doc itself
      doc.setAtPath(
        rest,
        value,
        undefined,
        this.transaction,
      );
      const write: Write = {
        address,
        value,
      };
      this.journal.addWrite(address);
      return { ok: write };
    } else if (first === "source") {
      // Only allow path length 1
      if (rest.length > 0) {
        const notFoundError = new NotFoundError(
          `Path beyond 'source' is not allowed`,
          address.id,
          [...address.path],
          undefined,
          address.space,
        );
        return { ok: undefined, error: notFoundError };
      }
      // Value must be a URI string (of:...)
      if (typeof value !== "string" || !value.startsWith("of:")) {
        const notFoundError = new NotFoundError(
          `Value for 'source' must be a URI string (of:...)`,
          address.id,
          [...address.path],
          value,
          address.space,
        );
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
        const notFoundError = new NotFoundError(
          `Source document not found: ${value}`,
          address.id,
          [...address.path],
          value,
          address.space,
        );
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
      const notFoundError = new NotFoundError(
        `Invalid first path element: ${String(first)}`,
        address.id,
        [...address.path],
        undefined,
        address.space,
      );
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
      writer = new TransactionWriter(this.runtime, space, this.journal, this);
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
      // Create parent entries if needed
      const lastValidPath = (writeResult.error as INotFoundError).path;
      const valueObj = lastValidPath
        ? this.readValueOrThrow({ ...address, path: lastValidPath }, {
          meta: ignoreReadForScheduling,
        })
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
            (Number.isInteger(Number(key)) ? [] : {}) as typeof nextValue;
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

/**
 * Factory for creating shim storage transactions.
 * Implements the same interface as IStorageManager.edit() for creating transactions.
 */
export class ShimStorageManager implements IStorageSubscriptionCapability {
  private subscriptions: IStorageSubscription[] = [];

  constructor(private runtime: IRuntime) {}

  /**
   * Creates a new storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IStorageTransaction {
    return new StorageTransaction(this.runtime);
  }

  /**
   * Subscribes to the storage manager's notifications.
   *
   * For the shim implementation, this is a no-op since shim transactions
   * don't generate storage notifications.
   */
  subscribe(subscription: IStorageSubscription): void {
    this.subscriptions.push(subscription);
  }

  /**
   * Internal method to notify subscribers of storage events.
   * This is called by transactions when they commit or encounter errors.
   */
  notifySubscribers(notification: StorageNotification): void {
    // Filter out subscriptions that have been cancelled
    this.subscriptions = this.subscriptions.filter((subscription) => {
      try {
        const result = subscription.next(notification);
        return result?.done !== true;
      } catch (error) {
        // If subscription throws an error, remove it
        return false;
      }
    });
  }
}

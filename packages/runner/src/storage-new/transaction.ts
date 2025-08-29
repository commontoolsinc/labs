import type {
  CommitError,
  IAttestation,
  IMemorySpaceAddress,
  InactiveTransactionError,
  IReadOptions,
  IStorageTransaction,
  ITransactionReader,
  ITransactionWriter,
  JSONValue,
  MemorySpace,
  ReaderError,
  Result,
  StorageTransactionStatus,
  Unit,
  WriteError,
  WriterError,
} from "../storage/interface.ts";

/**
 * Minimal skeleton that wraps an existing IStorageTransaction. This will be
 * replaced with an implementation backed by StorageClient.newTransaction().
 */
export class NewStorageTransaction implements IStorageTransaction {
  constructor(private readonly delegate: IStorageTransaction) {}

  get journal() {
    return this.delegate.journal;
  }

  status(): StorageTransactionStatus {
    return this.delegate.status();
  }

  reader(space: MemorySpace): Result<ITransactionReader, ReaderError> {
    return this.delegate.reader(space);
  }

  writer(space: MemorySpace): Result<ITransactionWriter, WriterError> {
    return this.delegate.writer(space);
  }

  read(
    address: IMemorySpaceAddress,
    options?: IReadOptions,
  ): Result<IAttestation, import("../storage/interface.ts").ReadError> {
    return this.delegate.read(address, options);
  }

  write(
    address: IMemorySpaceAddress,
    value?: JSONValue,
  ): Result<IAttestation, WriterError | WriteError> {
    return this.delegate.write(address, value);
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    return this.delegate.abort(reason);
  }

  commit(): Promise<Result<Unit, CommitError>> {
    return this.delegate.commit();
  }
}

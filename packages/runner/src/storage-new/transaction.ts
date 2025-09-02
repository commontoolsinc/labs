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
import { StorageClient } from "../../../storage/src/client/index.ts";
import { docIdFromUri, pathFromAddress } from "./address.ts";

/**
 * Minimal skeleton that wraps an existing IStorageTransaction. This will be
 * replaced with an implementation backed by StorageClient.newTransaction().
 */
export class NewStorageTransaction implements IStorageTransaction {
  #clientTx: import("../../../storage/src/client/tx.ts").ClientTransaction;
  constructor(
    private readonly delegate: IStorageTransaction,
    client?: StorageClient,
  ) {
    // For now, we always create a client transaction to prepare for migration.
    // If client is omitted, we operate as a pure wrapper.
    this.#clientTx = (client?.newTransaction?.() as any) ?? {
      read: () => undefined,
      write: () => false,
      commit: async () => ({ status: "ok" as const }),
      abort: () => {},
    } as any;
  }

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
    // Prefer delegate semantics to keep runner behavior stable for now.
    // In parallel, make client tx aware of reads to enable future migration.
    try {
      const { space, id, path } = address;
      const docId = docIdFromUri(id);
      this.#clientTx.read?.(String(space), docId, pathFromAddress(address));
    } catch {}
    return this.delegate.read(address, options);
  }

  write(
    address: IMemorySpaceAddress,
    value?: JSONValue,
  ): Result<IAttestation, WriterError | WriteError> {
    // Stage on delegate for current behavior.
    // Also mirror into client tx by applying a small mutation closure at path.
    try {
      const { space, id } = address;
      const path = pathFromAddress(address);
      const docId = docIdFromUri(id);
      const ok = this.#clientTx.write?.(
        String(space),
        docId,
        path,
        (sub: unknown) => {
          if (path.length === 0) {
            return;
          }
          // When a value is provided, set it on the sub-proxy
          // For deletes, value === undefined — client tx will treat as retraction on commit
          try {
            // @ts-ignore index signature at runtime via Automerge proxies
            const key = path[path.length - 1];
            // If we are at root, sub is the doc; else sub is parent container
            // set/replace value
            // For arrays, numeric keys work as indices
            // deno-lint-ignore no-explicit-any
            (sub as any)[key] = value as any;
          } catch {
            // best-effort mirror only
          }
        },
      );
      if (!ok) {
        // No-op; delegate remains source of truth for error reporting
      }
    } catch {}
    return this.delegate.write(address, value);
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    return this.delegate.abort(reason);
  }

  async commit(): Promise<Result<Unit, CommitError>> {
    // Defer to delegate to produce runner notifications and replica updates
    const res = await this.delegate.commit();
    try {
      // If delegate commit succeeded with writes, mirror the client tx commit
      // to keep client overlay state in sync; we don't fail runner commit on this.
      await this.#clientTx.commit?.();
    } catch {}
    return res;
  }
}

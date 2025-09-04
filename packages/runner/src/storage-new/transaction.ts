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

function getAtPathValue(root: unknown, path: string[]): unknown {
  if (!path || path.length === 0) return root;
  let cur: unknown = root;
  for (const token of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    const idx = Number.isInteger(Number(token)) ? Number(token) : undefined;
    if (Array.isArray(cur) && idx !== undefined && idx >= 0) {
      cur = (cur as unknown[])[idx];
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, token)) {
      cur = obj[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Minimal skeleton that wraps an existing IStorageTransaction. This will be
 * replaced with an implementation backed by StorageClient.newTransaction().
 */
export class NewStorageTransaction implements IStorageTransaction {
  #clientTx: import("../../../storage/src/client/tx.ts").ClientTransaction;
  #client?: StorageClient;
  constructor(
    private readonly delegate: IStorageTransaction,
    client?: StorageClient,
  ) {
    // For now, we always create a client transaction to prepare for migration.
    // If client is omitted, we operate as a pure wrapper.
    this.#client = client;
    this.#clientTx = (client?.newTransaction?.() as any) ?? {
      read: () => undefined,
      write: () => false,
      // No await usage in placeholder commit; return resolved status
      // deno-lint-ignore require-await
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
    // Prefer delegate semantics for invariants and error typing, but use
    // client overlay/store for the JSON value returned on success.
    let optimisticValue: unknown = undefined;
    try {
      const { space, id } = address;
      const docId = docIdFromUri(id);
      const path = pathFromAddress(address);
      optimisticValue = this.#clientTx.read?.(
        String(space),
        docId,
        path,
        true,
      );
    } catch {
      // ignore client read mirror failures
    }
    const base = this.delegate.read(address, options);
    if ((base as { ok?: IAttestation }).ok) {
      const att = (base as { ok: IAttestation }).ok;
      const composed = (() => {
        if (optimisticValue !== undefined) return optimisticValue as JSONValue;
        try {
          if (!this.#client) return undefined;
          const { space, id } = address;
          const docId = docIdFromUri(id);
          const view = this.#client.readView(String(space), docId).json;
          const tokens = pathFromAddress(address);
          return getAtPathValue(view, tokens);
        } catch {
          // ignore composed view errors and fall back to undefined
          return undefined;
        }
      })();
      return { ok: { address: att.address, value: composed } } as Result<
        IAttestation,
        any
      >;
    }
    return base;
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
    } catch {
      // ignore client write mirror failures
    }
    return this.delegate.write(address, value);
  }

  abort(reason?: unknown): Result<Unit, InactiveTransactionError> {
    const res = this.delegate.abort(reason);
    try {
      // Ensure client tx is closed and overlays cleared.
      this.#clientTx.abort?.();
    } catch {
      // ignore abort mirror failures
    }
    return res;
  }

  async commit(): Promise<Result<Unit, CommitError>> {
    // Defer to delegate to produce runner notifications and replica updates
    const res = await this.delegate.commit();
    try {
      // If delegate commit succeeded with writes, mirror the client tx commit
      // to keep client overlay state in sync; we don't fail runner commit on this.
      await this.#clientTx.commit?.();
    } catch {
      // ignore client tx commit failures; delegate result is authoritative
    }
    return res;
  }
}

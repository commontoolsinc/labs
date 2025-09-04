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
import { docIdFromUri, pathFromAddress, uriFromDocId } from "./address.ts";
import type { ITransactionJournal } from "../storage/interface.ts";

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

  get journal(): ITransactionJournal {
    const delegateJournal = this.delegate.journal;
    return {
      activity(): Iterable<import("../storage/interface.ts").Activity> {
        const base = Array.from(delegateJournal.activity?.() ?? []);
        // Append client write operations as lightweight activities for scheduler
        // conversion. We ignore reads here and rely on delegate for them.
        const extras: Array<import("../storage/interface.ts").Activity> = [];
        try {
          for (
            const entry
              of ((this as unknown as NewStorageTransaction).#clientTx as any)
                .log ?? []
          ) {
            if (entry && entry.op === "write") {
              const uri = uriFromDocId(entry.docId) ?? entry.docId;
              extras.push({
                write: {
                  space: entry.space as MemorySpace,
                  id: uri as any,
                  type: "application/json" as const,
                  path: ["value", ...(entry.path ?? [])],
                },
              } as any);
            }
          }
        } catch {
          // ignore log aggregation failures
        }
        return [...base, ...extras];
      },
      novelty(space: MemorySpace) {
        return delegateJournal.novelty?.(space) as any;
      },
      history(space: MemorySpace) {
        return delegateJournal.history?.(space) as any;
      },
    } as ITransactionJournal;
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
          // Root-level replacement is not mirrored in the scaffold to avoid
          // unintended shape changes; delegate remains source of truth.
          if (path.length === 0) return;
          try {
            const key = path[path.length - 1]!;
            const idx = Number.isInteger(Number(key)) ? Number(key) : undefined;
            // Delete semantics when value is undefined
            if (value === undefined) {
              if (Array.isArray(sub) && idx !== undefined && idx >= 0) {
                // deno-lint-ignore no-explicit-any
                (sub as any).splice(idx, 1);
              } else {
                // deno-lint-ignore no-explicit-any
                delete (sub as any)[key as any];
              }
              return;
            }
            // Assign/replace for object or array entries
            // deno-lint-ignore no-explicit-any
            (sub as any)[key as any] = value as any;
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
      // Only mirror client commit on success; on error, abort client tx overlays
      if ((res as { ok?: Unit }).ok) {
        await this.#clientTx.commit?.();
      } else {
        this.#clientTx.abort?.();
      }
    } catch {
      // ignore client tx commit failures; delegate result is authoritative
    }
    return res;
  }
}

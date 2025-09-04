import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  IAttestation,
  IMemorySpaceAddress,
  IStorageTransaction,
  JSONValue,
  MemorySpace,
  Result,
  Unit,
} from "../src/storage/interface.ts";
import { NewStorageTransaction } from "../src/storage-new/transaction.ts";

function addr(path: string[] = []): IMemorySpaceAddress {
  return {
    space: "did:key:z6Mktest" as MemorySpace,
    id: "of:abc" as any,
    type: "application/json" as any,
    path,
  };
}

describe("storage-new/transaction", () => {
  it("read prefers client overlay value from clientTx.read", () => {
    // Stub client with a clientTx that returns an optimistic value
    let abortCalled = false;
    const client = {
      newTransaction() {
        return {
          read: () => ({ v: 42 }),
          write: () => false,
          commit: async () => ({ status: "ok" as const }),
          abort: () => {
            abortCalled = true;
          },
        };
      },
      readView: (_space: string, _docId: string) => ({
        json: undefined,
        version: { epoch: -1 },
      }),
    } as any;

    // Minimal delegate that always returns ok with a base value
    const delegate: IStorageTransaction = {
      get journal() {
        return {
          activity: () => [],
          novelty: () => [],
          history: () => [],
        } as any;
      },
      status: () => ({ status: "ready", journal: {} as any }),
      reader: () => ({ ok: {} as any } as Result<any, any>),
      writer: () => ({ ok: {} as any } as Result<any, any>),
      read: (
        a: IMemorySpaceAddress,
      ) => ({
        ok: { address: a, value: { base: true } } as IAttestation,
      } as Result<
        IAttestation,
        any
      >),
      write: () => ({
        ok: { address: addr(), value: undefined } as IAttestation,
      } as Result<
        IAttestation,
        any
      >),
      abort: () => ({ ok: {} as Unit } as Result<Unit, any>),
      commit: async () => ({ ok: {} as Unit } as Result<Unit, any>),
    };

    const tx = new NewStorageTransaction(delegate, client);
    const res = tx.read(addr(["x"])) as { ok: IAttestation };
    expect(res.ok.value).toEqual({ v: 42 });
    // Ensure abort forwards to client tx
    tx.abort();
    expect(abortCalled).toBe(true);
  });

  it("read falls back to client.readView when clientTx.read returns undefined", () => {
    // Stub client where clientTx.read returns undefined, and readView provides json
    const client = {
      newTransaction() {
        return {
          read: () => undefined,
          write: () => false,
          commit: async () => ({ status: "ok" as const }),
          abort: () => {},
        };
      },
      readView: (_space: string, _docId: string) => ({
        json: { a: { b: 7 } },
        version: { epoch: 0 },
      }),
    } as any;

    const delegate: IStorageTransaction = {
      get journal() {
        return {
          activity: () => [],
          novelty: () => [],
          history: () => [],
        } as any;
      },
      status: () => ({ status: "ready", journal: {} as any }),
      reader: () => ({ ok: {} as any } as Result<any, any>),
      writer: () => ({ ok: {} as any } as Result<any, any>),
      read: (
        a: IMemorySpaceAddress,
      ) => ({
        ok: { address: a, value: { base: true } } as IAttestation,
      } as Result<
        IAttestation,
        any
      >),
      write: () => ({
        ok: { address: addr(), value: undefined } as IAttestation,
      } as Result<
        IAttestation,
        any
      >),
      abort: () => ({ ok: {} as Unit } as Result<Unit, any>),
      commit: async () => ({ ok: {} as Unit } as Result<Unit, any>),
    };

    const tx = new NewStorageTransaction(delegate, client);
    const res = tx.read(addr(["a", "b"])) as { ok: IAttestation };
    expect(res.ok.value as JSONValue).toEqual(7);
  });
});

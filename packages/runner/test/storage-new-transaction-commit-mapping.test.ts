import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  IAttestation,
  IMemorySpaceAddress,
  IStorageTransaction,
  Result,
  Unit,
} from "../src/storage/interface.ts";
import { NewStorageTransaction } from "../src/storage-new/transaction.ts";

function addr(): IMemorySpaceAddress {
  return {
    space: "did:key:z6Mktest" as any,
    id: "of:abc" as any,
    type: "application/json" as any,
    path: [],
  };
}

function makeDelegate(commitOk: boolean): IStorageTransaction {
  return {
    get journal() {
      return {
        activity: () => [],
        novelty: () => [],
        history: () => [],
      } as any;
    },
    status: () => ({ status: "ready", journal: {} as any }),
    reader: () => ({ ok: {} } as any),
    writer: () => ({ ok: {} } as any),
    read: (a: IMemorySpaceAddress) =>
      ({ ok: { address: a, value: undefined } as IAttestation }) as Result<
        IAttestation,
        any
      >,
    write: (a: IMemorySpaceAddress) =>
      ({ ok: { address: a, value: undefined } as IAttestation }) as Result<
        IAttestation,
        any
      >,
    abort: () => ({ ok: {} as Unit }) as Result<Unit, any>,
    commit: async () =>
      commitOk
        ? ({ ok: {} as Unit } as Result<Unit, any>)
        : ({ error: new Error("fail") } as Result<Unit, any>),
  } as IStorageTransaction;
}

describe("storage-new/transaction commit mapping", () => {
  it("calls client commit on delegate ok; aborts overlay on delegate error", async () => {
    let clientCommitCount = 0;
    let clientAbortCount = 0;
    const clientOk = {
      newTransaction() {
        return {
          read: () => undefined,
          write: () => true,
          commit: async () => {
            clientCommitCount++;
            return { status: "ok" as const };
          },
          abort: () => {
            clientAbortCount++;
          },
        } as any;
      },
      readView: () => ({ json: undefined, version: { epoch: -1 } }),
    } as any;

    const txOk = new NewStorageTransaction(makeDelegate(true), clientOk);
    await txOk.commit();
    expect(clientCommitCount).toBe(1);
    expect(clientAbortCount).toBe(0);

    const clientErr = {
      newTransaction() {
        return {
          read: () => undefined,
          write: () => true,
          commit: async () => {
            clientCommitCount++;
            return { status: "ok" as const };
          },
          abort: () => {
            clientAbortCount++;
          },
        } as any;
      },
      readView: () => ({ json: undefined, version: { epoch: -1 } }),
    } as any;

    const txErr = new NewStorageTransaction(makeDelegate(false), clientErr);
    await txErr.commit();
    expect(clientAbortCount).toBe(1);
  });
});

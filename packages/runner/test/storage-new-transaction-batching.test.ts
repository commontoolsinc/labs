import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  IAttestation,
  IStorageTransaction,
  JSONValue,
  Result,
  Unit,
} from "../src/storage/interface.ts";
import { NewStorageTransaction } from "../src/storage-new/transaction.ts";

function addr(id: string, path: string[] = []) {
  return {
    space: "did:key:z6Mktest" as any,
    id: id as any,
    type: "application/json" as any,
    path,
  };
}

describe("storage-new/transaction batching", () => {
  it("stages writes to multiple docs and commits once via client tx", async () => {
    const writes: Array<{ space: string; docId: string; path: string[] }>[] =
      [];
    let commitCount = 0;
    const client = {
      newTransaction() {
        const localWrites: Array<
          { space: string; docId: string; path: string[] }
        > = [];
        writes.push(localWrites);
        return {
          read: () => undefined,
          write: (
            space: string,
            docId: string,
            path: string[],
            _mutate: (sub: unknown) => void,
          ) => {
            localWrites.push({ space, docId, path: path.slice() });
            return true;
          },
          commit() {
            commitCount++;
            return { status: "ok" as const };
          },
          abort: () => {},
        } as any;
      },
      readView: (_space: string, _docId: string) => ({
        json: undefined,
        version: { epoch: -1 },
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
      reader: () => ({ ok: {} } as any),
      writer: () => ({ ok: {} } as any),
      read: (
        a,
      ) => ({ ok: { address: a, value: undefined } as IAttestation } as Result<
        IAttestation,
        any
      >),
      write: (
        a,
        _v?: JSONValue,
      ) => ({ ok: { address: a, value: undefined } as IAttestation } as Result<
        IAttestation,
        any
      >),
      abort: () => ({ ok: {} as Unit } as Result<Unit, any>),
      commit: async () => {
        await Promise.resolve();
        return { ok: {} as Unit } as Result<Unit, any>;
      },
    };

    const tx = new NewStorageTransaction(delegate, client);
    // Stage writes to two different docs in the same space
    expect(tx.write(addr("of:one", ["x"]), 1).ok).toBeDefined();
    expect(tx.write(addr("of:two", ["y"]), 2).ok).toBeDefined();

    const res = await tx.commit();
    expect(res.ok).toBeDefined();
    // One client transaction should have been committed
    expect(commitCount).toBe(1);
    // Ensure both writes were staged through client tx
    expect(writes.length).toBe(1);
    expect(writes[0]!.length).toBe(2);
    expect(writes[0]![0]!.docId.startsWith("doc:")).toBe(true);
    expect(writes[0]![1]!.docId.startsWith("doc:")).toBe(true);
  });
});

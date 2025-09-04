import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NewStorageProvider } from "../src/storage-new/provider.ts";

describe("storage-new/provider replica", () => {
  it("replica.did returns space DID and get returns current state", () => {
    const client = {
      readView: (_space: string, _docId: string) => ({
        json: { hello: "world" },
        version: { epoch: 1 },
      }),
      async get() {},
      async synced() {},
      async disconnect() {},
    } as any;
    const delegate = {
      replica: {} as any,
      async send() {
        return { ok: {} } as any;
      },
      async sync() {
        return { ok: {} } as any;
      },
      async synced() {},
      get() {
        return undefined;
      },
      sink() {
        return () => {};
      },
      async destroy() {},
      getReplica() {
        return undefined;
      },
    } as any;
    const space = "did:key:z6Mktest" as any;
    const p = new NewStorageProvider(client, space, delegate);
    expect(p.replica.did()).toBe(space);
    const state = p.replica.get({
      id: "of:abc" as any,
      type: "application/json",
    });
    expect(state?.of).toBe("of:abc");
    expect(state?.the).toBe("application/json");
    expect((state as any)?.is).toEqual({ hello: "world" });
  });
});

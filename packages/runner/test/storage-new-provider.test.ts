import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NewStorageProvider } from "../src/storage-new/provider.ts";
import type {
  IStorageProviderWithReplica,
  SchemaPathSelector,
  URI,
} from "../src/storage/interface.ts";

describe("storage-new/provider", () => {
  it("sync forwards schemaContext in query and returns ok", async () => {
    const calls: any[] = [];
    const client = {
      async get(
        space: string,
        opts: {
          consumerId: string;
          query: { docId: string; path?: string[]; schema?: unknown };
        },
      ) {
        calls.push({ space, opts });
        return { json: {}, version: { epoch: 0 } };
      },
      async synced() {},
      async disconnect() {},
    } as any;
    const delegate: IStorageProviderWithReplica = {
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
    };
    const p = new NewStorageProvider(
      client,
      "did:key:z6Mktest" as any,
      delegate,
    );
    const selector: SchemaPathSelector = {
      path: ["a"],
      schemaContext: { schema: true, rootSchema: true },
    } as any;
    const res = await p.sync("of:abc" as URI, selector);
    expect(res.ok).toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0].opts.query.schema).toEqual(selector.schemaContext);
  });
});

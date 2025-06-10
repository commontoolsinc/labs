import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { Storage } from "../src/storage.ts";
import { type CellLink } from "../src/cell.ts";
import { type DocImpl } from "../src/doc.ts";
import { Identity } from "@commontools/identity";
import * as Memory from "@commontools/memory";
import * as Consumer from "@commontools/memory/consumer";
import { Provider } from "../src/storage/cache.ts";

const signer = await Identity.fromPassphrase("test operator");

describe("Storage", () => {
  let runtime: Runtime;

  let provider: Memory.Provider.Provider<Memory.Protocol>;
  let consumer: Consumer.MemoryConsumer<Consumer.MemorySpace>;
  let testDoc: DocImpl<any>;
  let n = 0;
  const storageManager = {
    open: (space: Consumer.MemorySpace) =>
      Provider.open({
        space,
        session: consumer,
      }),
  };

  beforeEach(async () => {
    // Create memory service for testing
    const open = await Memory.Provider.open({
      store: new URL("memory://db/"),
      serviceDid: signer.did(),
    });

    if (open.error) {
      throw open.error;
    }

    provider = open.ok;

    consumer = Consumer.open({
      as: signer,
      session: provider.session(),
    });

    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    testDoc = runtime.documentMap.getDoc<string>(
      undefined as unknown as string,
      `storage test cell ${n++}`,
      signer.did(),
    );
  });

  afterEach(async () => {
    await runtime?.storage.cancelAll();
    await provider?.close();
    // _processCurrentBatch leaves sleep behind that makes deno error
    await new Promise((wake) => setTimeout(wake, 1));
  });

  describe("persistDoc", () => {
    it("should persist a doc", async () => {
      const testValue = { data: "test" };
      testDoc.send(testValue);

      await runtime.storage.syncCell(testDoc);

      const query = consumer
        .mount(signer.did())
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact.is).toEqual({ value: testValue });
    });

    it("should persist a cells and referenced cell references within it", async () => {
      const refDoc = runtime.documentMap.getDoc(
        "hello",
        "should persist a cells and referenced cell references within it",
        "test",
      );

      const testValue = {
        data: "test",
        ref: { cell: refDoc, path: [] },
      };
      testDoc.send(testValue);

      await runtime.storage.syncCell(testDoc);

      const entry = storageManager.open(signer.did()).get(refDoc.entityId);
      expect(entry?.value).toEqual("hello");
    });

    it("should persist a cells and referenced cells within it", async () => {
      const refDoc = runtime.documentMap.getDoc(
        "hello",
        "should persist a cells and referenced cells 1",
        "test",
      );

      const testValue = {
        data: "test",
        otherDoc: refDoc,
      };
      testDoc.send(testValue);

      await runtime.storage.syncCell(testDoc);

      const query = consumer
        .mount(signer.did())
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact?.is).toEqual({ value: "hello" });
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates", async () => {
      await runtime.storage.syncCell(testDoc);

      testDoc.send("value 1");
      testDoc.send("value 2");

      await runtime.storage.synced();

      const query = consumer
        .mount(signer.did())
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact?.is).toEqual({ value: "value 2" });
    });
  });

  describe("syncDoc", () => {
    it("should wait for a doc to appear", async () => {
      let synced = false;

      storageManager.open(signer.did()).sync(testDoc.entityId!, true).then(
        () => (synced = true),
      );
      expect(synced).toBe(false);

      testDoc.send("test");
      await runtime.storage.syncCell(testDoc);
      expect(synced).toBe(true);
    });

    it("should wait for a undefined doc to appear", async () => {
      let synced = false;
      storageManager.open(signer.did()).sync(testDoc.entityId!, true).then(
        () => (synced = true),
      );
      expect(synced).toBe(false);

      await runtime.storage.syncCell(testDoc);
      expect(synced).toBe(true);
    });
  });

  describe("ephemeral docs", () => {
    it("should not be loaded from storage", async () => {
      const ephemeralDoc = runtime.documentMap.getDoc(
        "transient",
        "ephemeral",
        "test",
      );
      ephemeralDoc.ephemeral = true;
      await runtime.storage.syncCell(ephemeralDoc);
      const provider = storageManager.open(signer.did());

      await provider.sync(ephemeralDoc.entityId!);
      const record = provider.get(ephemeralDoc.entityId!);
      expect(record).toBeUndefined();
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates with schema", async () => {
      await runtime.storage.syncCell(testDoc, false, {
        schema: true,
        rootSchema: true,
      });

      testDoc.send("value 1");
      testDoc.send("value 2");

      await runtime.storage.synced();

      const query = consumer
        .mount(signer.did())
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact?.is).toEqual({ value: "value 2" });
    });
  });
});

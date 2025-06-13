import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { type DocImpl } from "../src/doc.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Storage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let testDoc: DocImpl<any>;
  let n = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });

    testDoc = runtime.documentMap.getDoc<string>(
      undefined as unknown as string,
      `storage test cell ${n++}`,
      space,
    );
  });

  afterEach(async () => {
    await runtime?.storage.cancelAll();
    await storageManager?.close();
    // _processCurrentBatch leaves sleep behind that makes deno error
    await new Promise((wake) => setTimeout(wake, 1));
  });

  describe("persistDoc", () => {
    it("should persist a doc", async () => {
      const testValue = { data: "test" };
      testDoc.send(testValue);

      await runtime.storage.syncCell(testDoc);

      const query = storageManager
        .mount(space)
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
        space,
      );

      const testValue = {
        data: "test",
        ref: { cell: refDoc, path: [] },
      };
      testDoc.send(testValue);

      await runtime.storage.syncCell(testDoc);

      const entry = storageManager.open(space).get(refDoc.entityId);
      expect(entry?.value).toEqual("hello");
    });

    it("should persist a cells and referenced cells within it", async () => {
      const refDoc = runtime.documentMap.getDoc(
        "hello",
        "should persist a cells and referenced cells 1",
        space,
      );

      const testValue = {
        data: "test",
        otherDoc: refDoc,
      };
      testDoc.send(testValue);

      await runtime.storage.syncCell(testDoc);

      const entry = storageManager.open(space).get(refDoc.entityId);
      expect(entry?.value).toEqual("hello");
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates", async () => {
      await runtime.storage.syncCell(testDoc);

      testDoc.send("value 1");
      testDoc.send("value 2");

      await runtime.storage.synced();

      const query = storageManager
        .mount(space)
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

      storageManager.open(space).sync(testDoc.entityId!, true).then(
        () => (synced = true),
      );
      expect(synced).toBe(false);

      testDoc.send("test");
      await runtime.storage.syncCell(testDoc);
      expect(synced).toBe(true);
    });

    it("should wait for a undefined doc to appear", async () => {
      let synced = false;
      storageManager.open(space).sync(testDoc.entityId!, true).then(
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
        space,
      );
      ephemeralDoc.ephemeral = true;
      await runtime.storage.syncCell(ephemeralDoc);
      const provider = storageManager.open(space);

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

      const query = storageManager
        .mount(space)
        .query({
          select: { _: { "application/json": {} } },
        });

      await query;

      const [fact] = query.facts;

      expect(fact?.is).toEqual({ value: "value 2" });
    });
  });
});

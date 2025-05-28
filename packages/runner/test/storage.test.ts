import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "../src/runtime.ts";
import { StorageProvider } from "../src/storage/base.ts";
import { type CellLink } from "../src/cell.ts";
import { type DocImpl } from "../src/doc.ts";
import { VolatileStorageProvider } from "../src/storage/volatile.ts";
import { Identity } from "@commontools/identity";

const signer = await Identity.fromPassphrase("test operator");

describe("Storage", () => {
  let runtime: Runtime;
  let storage2: StorageProvider;
  let testDoc: DocImpl<any>;
  let n = 0;

  beforeEach(() => {
    // Create shared storage provider for testing
    storage2 = new VolatileStorageProvider("test");
    
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      storageUrl: "volatile://test",
      signer: signer
    });
    
    // Replace the storage's default provider with our shared storage
    (runtime.storage as any).storageProviders.set("default", storage2);
    testDoc = runtime.documentMap.getDoc<string>(
      undefined as unknown as string,
      `storage test cell ${n++}`,
      "test",
    );
  });

  afterEach(async () => {
    await runtime?.storage.cancelAll();
    await storage2?.destroy();
  });

  describe("persistDoc", () => {
    it("should persist a doc", async () => {
      const testValue = { data: "test" };
      testDoc.send(testValue);

      await runtime.storage.syncCell(testDoc);

      await storage2.sync(testDoc.entityId!);
      const value = storage2.get(testDoc.entityId!);
      expect(value?.value).toEqual(testValue);
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

      await storage2.sync(refDoc.entityId!);
      const value = storage2.get(refDoc.entityId!);
      expect(value?.value).toEqual("hello");
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

      await storage2.sync(refDoc.entityId!);
      const value = storage2.get(refDoc.entityId!);
      expect(value?.value).toEqual("hello");
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates", async () => {
      await runtime.storage.syncCell(testDoc);

      testDoc.send("value 1");
      testDoc.send("value 2");

      await runtime.storage.synced();

      await storage2.sync(testDoc.entityId!);
      const value = storage2.get(testDoc.entityId!);
      expect(value?.value).toBe("value 2");
    });
  });

  describe("syncDoc", () => {
    it("should wait for a doc to appear", async () => {
      let synced = false;
      storage2.sync(testDoc.entityId!, true).then(() => (synced = true));
      expect(synced).toBe(false);

      testDoc.send("test");
      await runtime.storage.syncCell(testDoc);
      expect(synced).toBe(true);
    });

    it("should wait for a undefined doc to appear", async () => {
      let synced = false;
      storage2.sync(testDoc.entityId!, true).then(() => (synced = true));
      expect(synced).toBe(false);

      await runtime.storage.syncCell(testDoc);
      expect(synced).toBe(true);
    });
  });

  describe("ephemeral docs", () => {
    it("should not be loaded from storage", async () => {
      const ephemeralDoc = runtime.documentMap.getDoc("transient", "ephemeral", "test");
      ephemeralDoc.ephemeral = true;
      await runtime.storage.syncCell(ephemeralDoc);

      await storage2.sync(ephemeralDoc.entityId!);
      const value = storage2.get(ephemeralDoc.entityId!);
      expect(value).toBeUndefined();
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

      await storage2.sync(testDoc.entityId!);
      const value = storage2.get(testDoc.entityId!);
      expect(value?.value).toBe("value 2");
    });
  });
});

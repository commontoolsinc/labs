import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { storage } from "../src/storage.ts";
import { StorageProvider } from "../src/storage/base.ts";
import { CellLink, createRef, DocImpl, getDoc } from "@commontools/runner";
import { VolatileStorageProvider } from "../src/storage/volatile.ts";
import { Identity } from "@commontools/identity";

storage.setRemoteStorage(new URL("volatile://"));
storage.setSigner(await Identity.fromPassphrase("test operator"));

describe("Storage", () => {
  let storage2: StorageProvider;
  let testDoc: DocImpl<any>;
  let n = 0;

  beforeEach(() => {
    storage2 = new VolatileStorageProvider("test");
    testDoc = getDoc<string>(
      undefined as unknown as string,
      `storage test cell ${n++}`,
      "test",
    );
  });

  afterEach(async () => {
    await storage?.cancelAll();
    await storage2?.destroy();
  });

  describe("persistDoc", () => {
    it("should persist a doc", async () => {
      const testValue = { data: "test" };
      testDoc.send(testValue);

      await storage.syncCell(testDoc);

      await storage2.sync(testDoc.entityId!);
      const value = storage2.get(testDoc.entityId!);
      expect(value?.value).toEqual(testValue);
    });

    it("should persist a cells and referenced cell references within it", async () => {
      const refDoc = getDoc(
        "hello",
        "should persist a cells and referenced cell references within it",
        "test",
      );

      const testValue = {
        data: "test",
        ref: { cell: refDoc, path: [] },
      };
      testDoc.send(testValue);

      await storage.syncCell(testDoc);

      await storage2.sync(refDoc.entityId!);
      const value = storage2.get(refDoc.entityId!);
      expect(value?.value).toEqual("hello");
    });

    it("should persist a cells and referenced cells within it", async () => {
      const refDoc = getDoc(
        "hello",
        "should persist a cells and referenced cells 1",
        "test",
      );

      const testValue = {
        data: "test",
        otherDoc: refDoc,
      };
      testDoc.send(testValue);

      await storage.syncCell(testDoc);

      await storage2.sync(refDoc.entityId!);
      const value = storage2.get(refDoc.entityId!);
      expect(value?.value).toEqual("hello");
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates", async () => {
      await storage.syncCell(testDoc);

      testDoc.send("value 1");
      testDoc.send("value 2");

      await storage.synced();

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
      await storage.syncCell(testDoc);
      expect(synced).toBe(true);
    });

    it("should wait for a undefined doc to appear", async () => {
      let synced = false;
      storage2.sync(testDoc.entityId!, true).then(() => (synced = true));
      expect(synced).toBe(false);

      await storage.syncCell(testDoc);
      expect(synced).toBe(true);
    });
  });

  describe("ephemeral docs", () => {
    it("should not be loaded from storage", async () => {
      const ephemeralDoc = getDoc("transient", "ephemeral", "test");
      ephemeralDoc.ephemeral = true;
      await storage.syncCell(ephemeralDoc);

      await storage2.sync(ephemeralDoc.entityId!);
      const value = storage2.get(ephemeralDoc.entityId!);
      expect(value).toBeUndefined();
    });
  });

  describe("doc updates", () => {
    it("should persist doc updates with schema", async () => {
      await storage.syncCell(testDoc, false, {
        schema: true,
        rootSchema: true,
      });

      testDoc.send("value 1");
      testDoc.send("value 2");

      await storage.synced();

      await storage2.sync(testDoc.entityId!);
      const value = storage2.get(testDoc.entityId!);
      expect(value?.value).toBe("value 2");
    });
  });
});

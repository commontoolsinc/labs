import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { storage } from "../src/storage.ts";
import { StorageProvider } from "../src/storage/base.ts";
import { InMemoryStorageProvider } from "../src/storage/memory.ts";
import { createRef, DocImpl, getDoc, getSpace } from "@commontools/runner";
import { Identity } from "@commontools/identity";

storage.setRemoteStorage(new URL("memory://"));
storage.setSigner(await Identity.fromPassphrase("test operator"));

describe("Storage", () => {
  let storage2: StorageProvider;
  let testCell: DocImpl<any>;

  beforeEach(() => {
    storage2 = new InMemoryStorageProvider("test");
    testCell = getDoc<string>(
      undefined as unknown as string,
      "storage test cell",
      getSpace("test"),
    );
  });

  afterEach(async () => {
    await storage?.cancelAll();
    await storage2?.destroy();
  });

  describe("persistCell", () => {
    it("should persist a cell", async () => {
      const testValue = { data: "test" };
      testCell.send(testValue);

      await storage.syncCell(testCell);

      await storage2.sync(testCell.entityId!);
      const value = storage2.get(testCell.entityId!);
      expect(value?.value).toEqual(testValue);
    });

    it("should persist a cells and referenced cell references within it", async () => {
      const refCell = getDoc(
        "hello",
        "should persist a cells and referenced cell references within it",
        getSpace("test"),
      );

      const testValue = {
        data: "test",
        ref: { cell: refCell, path: [] },
      };
      testCell.send(testValue);

      console.log("syncing testCell");
      await storage.syncCell(testCell);
      console.log("synced testCell");

      await storage2.sync(refCell.entityId!);
      const value = storage2.get(refCell.entityId!);
      expect(value?.value).toEqual("hello");
    });

    it("should persist a cells and referenced cells within it", async () => {
      const refCell = getDoc(
        "hello",
        "should persist a cells and referenced cells 1",
        getSpace("test"),
      );

      const testValue = {
        data: "test",
        otherCell: refCell,
      };
      testCell.send(testValue);

      await storage.syncCell(testCell);

      await storage2.sync(refCell.entityId!);
      const value = storage2.get(refCell.entityId!);
      expect(value?.value).toEqual("hello");
    });
  });

  describe("cell updates", () => {
    it("should persist cell updates", async () => {
      await storage.syncCell(testCell);

      testCell.send("value 1");
      testCell.send("value 2");

      await storage.synced();

      await storage2.sync(testCell.entityId!);
      const value = storage2.get(testCell.entityId!);
      expect(value?.value).toBe("value 2");
    });
  });

  describe("syncCell", () => {
    it("should wait for a cell to appear", async () => {
      let synced = false;
      storage2.sync(testCell.entityId!, true).then(() => (synced = true));
      expect(synced).toBe(false);

      testCell.send("test");
      await storage.syncCell(testCell);
      expect(synced).toBe(true);
    });

    it("should wait for a undefined cell to appear", async () => {
      let synced = false;
      storage2.sync(testCell.entityId!, true).then(() => (synced = true));
      expect(synced).toBe(false);

      await storage.syncCell(testCell);
      expect(synced).toBe(true);
    });
  });

  describe("ephemeral cells", () => {
    it("should not be loaded from storage", async () => {
      const ephemeralCell = getDoc("transient", "ephemeral", getSpace("test"));
      ephemeralCell.ephemeral = true;
      await storage.syncCell(ephemeralCell);

      await storage2.sync(ephemeralCell.entityId!);
      const value = storage2.get(ephemeralCell.entityId!);
      expect(value).toBeUndefined();
    });
  });
});

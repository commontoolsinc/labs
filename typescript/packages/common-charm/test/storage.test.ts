import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { storage } from "../src/storage.ts";
import { StorageProvider } from "../src/storage/base.ts";
import { InMemoryStorageProvider } from "../src/storage/memory.ts";
import { getDoc, DocImpl, createRef, getSpace } from "@commontools/runner";

storage.setRemoteStorage(new URL("memory://"));

describe("Storage", () => {
  let storage2: StorageProvider;
  let testCell: DocImpl<any>;

  beforeEach(() => {
    storage2 = new InMemoryStorageProvider("test");
    testCell = getDoc<string>();
    testCell.generateEntityId(undefined, getSpace("test"));
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
      const refCell = getDoc("hello");
      refCell.generateEntityId(undefined, getSpace("test"));

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
      const refCell = getDoc("hello");
      refCell.generateEntityId(undefined, getSpace("test"));

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

    it("should generate causal IDs for cells that don't have them yet", async () => {
      const testValue = {
        data: "test",
        ref: { cell: getDoc("hello"), path: [] },
      };
      testCell.send(testValue);

      await storage.syncCell(testCell);

      const refId = createRef(
        { value: "hello" },
        {
          cell: testCell.entityId?.toJSON?.(),
          path: ["ref"],
        },
      );
      await storage2.sync(refId);
      const value = storage2.get(refId);
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
    it("should only load a cell once", async () => {
      const cell1 = await storage.syncCell(testCell);
      expect(cell1).toBe(testCell);

      // Even when passing in a new cell with the same entityId, it should be
      // the same cell.
      const cell2 = getDoc();
      cell2.entityId = testCell.entityId;
      const cell3 = await storage.syncCell(cell2);
      expect(cell3).toBe(cell1);
    });

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

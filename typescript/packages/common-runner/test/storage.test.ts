// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStorage, Storage } from "../src/storage";
import { cell, CellImpl } from "../src/cell";

describe("Storage", () => {
  const storageTypes = ["memory", "local"] as const;

  storageTypes.forEach((storageType) => {
    describe(storageType, () => {
      let storage: Storage;
      let storage2: Storage;
      let testCell: CellImpl<any>;

      beforeEach(() => {
        storage = createStorage(storageType);
        storage2 = createStorage(storageType);
        testCell = cell<string>();
        testCell.generateEntityId();
      });

      afterEach(() => {
        storage.clear();
        storage2.clear();
      });

      describe("persistCell", () => {
        it("should persist a cell", async () => {
          const testValue = { data: "test" };
          testCell.send(testValue);

          await storage.persistCell(testCell);

          const newCell = await storage2.loadCell(testCell.entityId!);
          expect(newCell).not.toBe(testCell);
          expect(newCell.get()).toEqual(testValue);
        });
      });

      describe("cell updates", () => {
        it("should persist cell updates", async () => {
          await storage.loadCell(testCell);

          testCell.send("value 1");
          testCell.send("value 2");

          const newCell = await storage2.loadCell(testCell.entityId!);
          expect(newCell).not.toBe(testCell);
          expect(newCell.get()).toBe("value 2");
        });
      });

      describe("loadCell", () => {
        it("should load a cell that does not exist in storage", async () => {
          await storage.loadCell(testCell);
          expect(testCell.get()).toBeUndefined();
        });

        it.only("should load a cell and stay in sync", async () => {
          const testValue = { data: "test" };
          testCell.send(testValue);

          // This will persist the cell to storage, with the new value, since
          // the cell didn't yet exist in storage.
          await storage.loadCell(testCell);

          // Load cell from second storage instance
          const newCell = await storage2.loadCell(testCell.entityId!);
          expect(newCell).not.toBe(testCell);
          expect(newCell.get()).toEqual(testValue);

          // Let's update the cell; the other instance should get the update.
          testCell.send("value 2");

          // Wait for the update to propagate
          // await new Promise((resolve) => setTimeout(resolve, 100));
          console.log("newCell", newCell.entityId, newCell.get());
          expect(newCell.get()).toBe("value 2");

          // Now let's update the new cell and see that it propagates back.
          newCell.send("value 3");

          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(testCell.get()).toBe("value 3");
        });

        it("should only load a cell once", async () => {
          const cell1 = await storage.loadCell(testCell);
          expect(cell1).toBe(testCell);

          // Even when passing in a new cell with the same entityId, it should be
          // the same cell.
          const cell2 = cell();
          cell2.entityId = testCell.entityId;
          const cell3 = await storage.loadCell(cell2);
          expect(cell3).toBe(cell1);
        });
      });

      describe("createStorage", () => {
        it("should create memory storage", () => {
          const memoryStorage = createStorage("memory");
          expect(memoryStorage).toBeDefined();
        });

        it("should create local storage", () => {
          const localStorage = createStorage("local");
          expect(localStorage).toBeDefined();
        });

        it("should throw an error for invalid storage type", () => {
          expect(() => createStorage("invalid" as any)).toThrow(
            "Invalid storage type"
          );
        });
      });
    });
  });
});

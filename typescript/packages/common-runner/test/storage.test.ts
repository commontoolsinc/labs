// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStorage } from "../src/storage";
import { cell, CellImpl } from "../src/cell";

describe("Storage", () => {
  let storage: ReturnType<typeof createStorage>;
  let testCell: ReturnType<typeof cell>;

  beforeEach(() => {
    storage = createStorage("memory");
    testCell = cell<string>();
    testCell.generateEntityId();
  });

  afterEach(() => {
    // Clean up any subscriptions or side effects
  });

  describe("loadCell", () => {
    it("should load a cell that does not exist in storage", async () => {
      await storage.loadCell(testCell);
      expect(testCell.get()).toBeUndefined();
    });

    it("should load a cell that exists in storage and stay in sync", async () => {
      const testValue = { data: "test" };
      testCell.send(testValue);
      await storage.persistCell(testCell);

      const newCell = cell<string>();
      newCell.entityId = testCell.entityId;
      await storage.loadCell(newCell);
      expect(newCell.get()).toEqual(testValue);

      testCell.send("value 2");
      expect(newCell.get()).toBe("value 2");

      newCell.send("value 3");
      expect(testCell.get()).toBe("value 3");
    });

    it("should only load a cell once", async () => {
      await storage.loadCell(testCell);
      testCell.send("initial value");
      await storage.loadCell(testCell);
      expect(testCell.get()).toBe("initial value");
    });
  });

  describe("persistCell", () => {
    it("should persist a cell", async () => {
      const testValue = { data: "test" };
      testCell.send(testValue);

      await storage.persistCell(testCell);

      const newCell = cell();
      newCell.entityId = testCell.entityId;
      await storage.loadCell(newCell);
      expect(newCell.get()).toEqual(testValue);
    });
  });

  describe("cell updates", () => {
    it("should persist cell updates", async () => {
      await storage.loadCell(testCell);

      testCell.send("value 1");
      testCell.send("value 2");

      const newCell = cell();
      newCell.entityId = testCell.entityId;
      await storage.loadCell(newCell);
      expect(newCell.get()).toBe("value 2");
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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStorage, Storage } from "../src/storage.js";
import { cell, CellImpl, createRef } from "@commontools/common-runner";

// Create a mock window object
const createMockWindow = () => {
  let listeners = new Set<(event: any) => void>();

  const mockWindow: any = {
    localStorage: {
      getItem: vi.fn((key: string) => mockWindow.localStorage[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        const oldValue = mockWindow.localStorage[key];
        mockWindow.localStorage[key] = value;
        mockWindow.dispatchEvent(
          new StorageEvent("storage", {
            key,
            oldValue,
            newValue: value,
            storageArea: mockWindow.localStorage,
            url: mockWindow.location.href,
          })
        );
      }),
      removeItem: vi.fn((key: string) => {
        const oldValue = mockWindow.localStorage[key];
        delete mockWindow.localStorage[key];
        mockWindow.dispatchEvent(
          new StorageEvent("storage", {
            key,
            oldValue,
            newValue: null,
            storageArea: mockWindow.localStorage,
            url: mockWindow.location.href,
          })
        );
      }),
      clear: vi.fn(() => {
        mockWindow.localStorage = {};
        mockWindow.dispatchEvent(
          new StorageEvent("storage", {
            key: null,
            oldValue: null,
            newValue: null,
            storageArea: mockWindow.localStorage,
            url: mockWindow.location.href,
          })
        );
      }),
    },
    addEventListener: vi.fn((event: string, callback: (event: any) => void) => {
      if (event === "storage") listeners.add(callback);
    }),
    removeEventListener: vi.fn(
      (event: string, callback: (event: any) => void) => {
        if (event === "storage") listeners.delete(callback);
      }
    ),
    dispatchEvent: vi.fn((event: any) => {
      if (event.type === "storage") {
        listeners.forEach((callback) => callback(event));
      }
    }),
    location: {
      href: "http://localhost",
    },
  };

  return mockWindow;
};

// Create the mock window
const mockWindow = createMockWindow();

// Mock the global window object
vi.stubGlobal("window", mockWindow);
vi.stubGlobal("localStorage", mockWindow.localStorage);

// Mock StorageEvent if it doesn't exist
if (typeof StorageEvent === "undefined") {
  (global as any).StorageEvent = class StorageEvent {
    type: string;
    key: string | null;
    oldValue: string | null;
    newValue: string | null;
    url: string;
    storageArea: any;

    constructor(type: string, eventInitDict?: any) {
      this.type = type;
      this.key = eventInitDict?.key ?? null;
      this.oldValue = eventInitDict?.oldValue ?? null;
      this.newValue = eventInitDict?.newValue ?? null;
      this.url = eventInitDict?.url ?? "";
      this.storageArea = eventInitDict?.storageArea ?? null;
    }
  };
}
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
        storage.destroy();
        storage2.destroy();
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

        it("should persist a cells and referenced cell references within it", async () => {
          const refCell = cell("hello");
          refCell.generateEntityId();

          const testValue = {
            data: "test",
            ref: { cell: refCell, path: [] },
          };
          testCell.send(testValue);

          await storage.persistCell(testCell);

          const newCell = await storage2.loadCell(refCell.entityId!);
          expect(newCell.get()).toEqual("hello");
        });

        it("should persist a cells and referenced cells within it", async () => {
          const refCell = cell("hello");
          refCell.generateEntityId();

          const testValue = {
            data: "test",
            otherCell: refCell,
          };
          testCell.send(testValue);

          await storage.persistCell(testCell);

          const newCell = await storage2.loadCell(refCell.entityId!);
          expect(newCell.get()).toEqual("hello");
        });

        it("should generate causal IDs for cells that don't have them yet", async () => {
          const testValue = {
            data: "test",
            ref: { cell: cell("hello"), path: [] },
          };
          testCell.send(testValue);

          await storage.persistCell(testCell);

          const refId = createRef(
            { value: "hello" },
            {
              cell: testCell.entityId?.toJSON?.(),
              path: ["ref"],
            }
          );
          const newCell = await storage2.loadCell(refId);
          expect(newCell.get()).toEqual("hello");
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

          const newCell = await storage2.loadCell(testCell.entityId!);
          expect(newCell).not.toBe(testCell);
          expect(newCell.get()).toBeUndefined();

          testCell.send("value 1");
          await Promise.resolve(); // Wait for the update to propagate
          expect(newCell.get()).toBe("value 1");
        });

        it("should load a cell and stay in sync", async () => {
          const testValue = { data: "test" };
          testCell.send(testValue);

          // This will persist the cell to storage, with the new value, since
          // the cell didn't yet exist in storage.
          await storage.loadCell(testCell);

          // Load cell from second storage instance
          const newCell = await storage2.loadCell(testCell.entityId!);
          expect(newCell).not.toBe(testCell);
          expect(newCell.entityId).toEqual(testCell.entityId);
          expect(newCell.get()).toEqual(testValue);

          // Let's update the cell; the other instance should get the update.
          testCell.send("value 2");

          // Wait for the update to propagate
          await Promise.resolve(); // Wait for the update to propagate
          expect(newCell.get()).toBe("value 2");

          // Now let's update the new cell and see that it propagates back.
          newCell.send("value 3");

          await Promise.resolve(); // Wait for the update to propagate
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

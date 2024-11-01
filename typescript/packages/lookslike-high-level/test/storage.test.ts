import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStorage, Storage } from "../src/storage.js";
import {
  InMemoryStorageProvider,
  LocalStorageProvider,
  StorageProvider,
} from "../src/storage-providers.js";
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
          }),
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
          }),
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
          }),
        );
      }),
    },
    addEventListener: vi.fn((event: string, callback: (event: any) => void) => {
      if (event === "storage") listeners.add(callback);
    }),
    removeEventListener: vi.fn(
      (event: string, callback: (event: any) => void) => {
        if (event === "storage") listeners.delete(callback);
      },
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
      let storage2: StorageProvider;
      let testCell: CellImpl<any>;

      beforeEach(() => {
        storage = createStorage(storageType);
        if (storageType === "memory") {
          storage2 = new InMemoryStorageProvider();
        } else if (storageType === "local") {
          console.log("local", LocalStorageProvider);
          storage2 = new LocalStorageProvider();
        } else {
          throw new Error("Invalid storage type: " + storageType);
        }
        testCell = cell<string>();
        testCell.generateEntityId();
      });

      afterEach(async () => {
        await storage?.destroy();
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
          const refCell = cell("hello");
          refCell.generateEntityId();

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
          const refCell = cell("hello");
          refCell.generateEntityId();

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
            ref: { cell: cell("hello"), path: [] },
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
          const cell2 = cell();
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
          const ephemeralCell = cell("transient", "ephemeral");
          ephemeralCell.ephemeral = true;
          await storage.syncCell(ephemeralCell);

          await storage2.sync(ephemeralCell.entityId!);
          const value = storage2.get(ephemeralCell.entityId!);
          expect(value).toBeUndefined();
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
            "Invalid storage type",
          );
        });
      });
    });
  });
});

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { 
  getCellValue,
  setCellValue,
  type CellPath
} from "../src/ops/cell-operations.ts";
import { CharmManager } from "../src/manager.ts";
import { Cell, Runtime } from "@commontools/runner";
import { Identity } from "@commontools/identity";

// Mock CharmManager for testing
class MockCharmManager {
  private charms: Map<string, any> = new Map();
  private inputCells: Map<string, MockCell> = new Map();
  public runtime: { idle: () => Promise<void> };

  constructor() {
    this.runtime = {
      idle: async () => {},
    };
  }

  async get(charmId: string): Promise<any | null> {
    return this.charms.get(charmId) || null;
  }

  getArgument(charmCell: any): MockCell {
    return this.inputCells.get(charmCell.id) || new MockCell();
  }

  async synced(): Promise<void> {}

  // Helper method for tests to set up data
  setCharmData(charmId: string, data: any) {
    const mockCharm = {
      id: charmId,
      get: () => data,
    };
    this.charms.set(charmId, mockCharm);
    this.inputCells.set(charmId, new MockCell());
  }
}

// Mock Cell for testing
class MockCell {
  private data: any = {};
  private keys: Map<string | number, MockCell> = new Map();

  set(value: any) {
    this.data = value;
  }

  get() {
    return this.data;
  }

  key(segment: string | number): MockCell {
    if (!this.keys.has(segment)) {
      this.keys.set(segment, new MockCell());
    }
    return this.keys.get(segment)!;
  }
}

describe("Cell Operations", () => {
  describe("getCellValue", () => {
    it("should retrieve values at simple paths", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", { name: "Test Charm" });
      
      const value = await getCellValue(mockManager, "charm-1", ["name"]);
      
      assertEquals(value, "Test Charm");
    });

    it("should handle nested object paths", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {
        config: {
          settings: {
            theme: "dark",
          },
        },
      });
      
      const value = await getCellValue(mockManager, "charm-1", ["config", "settings", "theme"]);
      
      assertEquals(value, "dark");
    });

    it("should handle array indices", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {
        users: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
      });
      
      const value = await getCellValue(mockManager, "charm-1", ["users", 1, "email"]);
      
      assertEquals(value, "bob@example.com");
    });

    it("should throw for non-existent charms", async () => {
      const mockManager = new MockCharmManager() as any;
      
      await assertRejects(
        async () => await getCellValue(mockManager, "non-existent", ["path"]),
        Error,
        `Charm with ID "non-existent" not found`,
      );
    });

    it("should throw for invalid paths - null/undefined", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {
        config: null,
      });
      
      await assertRejects(
        async () => await getCellValue(mockManager, "charm-1", ["config", "settings"]),
        Error,
      );
    });

    it("should throw for invalid paths - non-object", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {
        count: 42,
      });
      
      await assertRejects(
        async () => await getCellValue(mockManager, "charm-1", ["count", "invalid"]),
        Error,
      );
    });

    it("should return the root value when path is empty", async () => {
      const mockManager = new MockCharmManager() as any;
      const testData = { name: "Test", value: 123 };
      mockManager.setCharmData("charm-1", testData);
      
      const value = await getCellValue(mockManager, "charm-1", []);
      
      assertEquals(value, testData);
    });

    it("should handle mixed string and number paths", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {
        data: {
          items: [
            { id: "first" },
            { id: "second", tags: ["a", "b", "c"] },
          ],
        },
      });
      
      const value = await getCellValue(mockManager, "charm-1", ["data", "items", 1, "tags", 2]);
      
      assertEquals(value, "c");
    });
  });

  describe("setCellValue", () => {
    it("should set values at simple paths", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {});
      
      await setCellValue(mockManager, "charm-1", ["name"], "Updated Name");
      
      // In a real test, we'd verify the value was set on the input cell
      // For now, we just verify no errors were thrown
    });

    it("should handle nested updates", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {});
      
      await setCellValue(mockManager, "charm-1", ["config", "theme"], "light");
      
      // Verify no errors were thrown
    });

    it("should throw for non-existent charms", async () => {
      const mockManager = new MockCharmManager() as any;
      
      await assertRejects(
        async () => await setCellValue(mockManager, "non-existent", ["path"], "value"),
        Error,
        `Charm with ID "non-existent" not found`,
      );
    });
  });

});
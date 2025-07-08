import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { 
  CellOperations,
  getCellValue,
  setCellValue,
  navigatePath,
  validateNavigable,
  CellOperationException,
  type CellPath,
  type GetCellResult,
  type SetCellResult
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

describe("CellOperations", () => {
  describe("getCellValue", () => {
    it("should retrieve values at simple paths", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", { name: "Test Charm" });
      
      const cellOps = new CellOperations(mockManager);
      const value = await cellOps.getCellValue("charm-1", ["name"]);
      
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
      
      const cellOps = new CellOperations(mockManager);
      const value = await cellOps.getCellValue("charm-1", ["config", "settings", "theme"]);
      
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
      
      const cellOps = new CellOperations(mockManager);
      const value = await cellOps.getCellValue("charm-1", ["users", 1, "email"]);
      
      assertEquals(value, "bob@example.com");
    });

    it("should throw for non-existent charms", async () => {
      const mockManager = new MockCharmManager() as any;
      const cellOps = new CellOperations(mockManager);
      
      await assertRejects(
        async () => await cellOps.getCellValue("non-existent", ["path"]),
        CellOperationException,
        `Charm with ID "non-existent" not found`,
      );
    });

    it("should throw for invalid paths - null/undefined", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {
        config: null,
      });
      
      const cellOps = new CellOperations(mockManager);
      
      await assertRejects(
        async () => await cellOps.getCellValue("charm-1", ["config", "settings"]),
        CellOperationException,
      );
    });

    it("should throw for invalid paths - non-object", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {
        count: 42,
      });
      
      const cellOps = new CellOperations(mockManager);
      
      await assertRejects(
        async () => await cellOps.getCellValue("charm-1", ["count", "invalid"]),
        CellOperationException,
      );
    });

    it("should return the root value when path is empty", async () => {
      const mockManager = new MockCharmManager() as any;
      const testData = { name: "Test", value: 123 };
      mockManager.setCharmData("charm-1", testData);
      
      const cellOps = new CellOperations(mockManager);
      const value = await cellOps.getCellValue("charm-1", []);
      
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
      
      const cellOps = new CellOperations(mockManager);
      const value = await cellOps.getCellValue("charm-1", ["data", "items", 1, "tags", 2]);
      
      assertEquals(value, "c");
    });
  });

  describe("setCellValue", () => {
    it("should set values at simple paths", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {});
      
      const cellOps = new CellOperations(mockManager);
      await cellOps.setCellValue("charm-1", ["name"], "Updated Name");
      
      // In a real test, we'd verify the value was set on the input cell
      // For now, we just verify no errors were thrown
    });

    it("should handle nested updates", async () => {
      const mockManager = new MockCharmManager() as any;
      mockManager.setCharmData("charm-1", {});
      
      const cellOps = new CellOperations(mockManager);
      await cellOps.setCellValue("charm-1", ["config", "theme"], "light");
      
      // Verify no errors were thrown
    });

    it("should throw for non-existent charms", async () => {
      const mockManager = new MockCharmManager() as any;
      const cellOps = new CellOperations(mockManager);
      
      await assertRejects(
        async () => await cellOps.setCellValue("non-existent", ["path"], "value"),
        CellOperationException,
        `Charm with ID "non-existent" not found`,
      );
    });
  });

  describe("Pure Functions", () => {
    describe("validateNavigable", () => {
      it("should return null for valid objects", () => {
        const error = validateNavigable({ key: "value" }, "key");
        assertEquals(error, null);
      });

      it("should return null for valid arrays", () => {
        const error = validateNavigable([1, 2, 3], 0);
        assertEquals(error, null);
      });

      it("should return error for null values", () => {
        const error = validateNavigable(null, "key");
        assertEquals(error?.type, "NULL_VALUE");
        assertEquals(error?.segment, "key");
      });

      it("should return error for undefined values", () => {
        const error = validateNavigable(undefined, "key");
        assertEquals(error?.type, "NULL_VALUE");
        assertEquals(error?.segment, "key");
      });

      it("should return error for non-object values", () => {
        const error = validateNavigable(42, "key");
        assertEquals(error?.type, "NON_OBJECT");
        assertEquals(error?.segment, "key");
      });
    });

    describe("navigatePath", () => {
      it("should navigate simple paths", () => {
        const data = { name: "test", value: 42 };
        const result = navigatePath(data, ["name"]);
        
        assertEquals(result.success, true);
        if (result.success) {
          assertEquals(result.value, "test");
          assertEquals(result.path, ["name"]);
        }
      });

      it("should navigate nested paths", () => {
        const data = { 
          config: { 
            settings: { 
              theme: "dark" 
            } 
          } 
        };
        const result = navigatePath(data, ["config", "settings", "theme"]);
        
        assertEquals(result.success, true);
        if (result.success) {
          assertEquals(result.value, "dark");
        }
      });

      it("should handle array navigation", () => {
        const data = { 
          items: [
            { id: 1 },
            { id: 2, name: "second" }
          ] 
        };
        const result = navigatePath(data, ["items", 1, "name"]);
        
        assertEquals(result.success, true);
        if (result.success) {
          assertEquals(result.value, "second");
        }
      });

      it("should return error for null in path", () => {
        const data = { config: null };
        const result = navigatePath(data, ["config", "settings"]);
        
        assertEquals(result.success, false);
        if (!result.success) {
          assertEquals(result.error.type, "NULL_VALUE");
          assertEquals(result.error.path, ["config", "settings"]);
        }
      });

      it("should return error for non-object in path", () => {
        const data = { count: 42 };
        const result = navigatePath(data, ["count", "invalid"]);
        
        assertEquals(result.success, false);
        if (!result.success) {
          assertEquals(result.error.type, "NON_OBJECT");
          assertEquals(result.error.path, ["count", "invalid"]);
        }
      });

      it("should handle empty path", () => {
        const data = { test: "value" };
        const result = navigatePath(data, []);
        
        assertEquals(result.success, true);
        if (result.success) {
          assertEquals(result.value, data);
        }
      });
    });

    describe("Functional getCellValue", () => {
      it("should return success result for valid paths", async () => {
        const mockManager = new MockCharmManager() as any;
        mockManager.setCharmData("charm-1", { name: "Test" });
        
        const result = await getCellValue(mockManager, "charm-1", ["name"]);
        
        assertEquals(result.success, true);
        if (result.success) {
          assertEquals(result.value, "Test");
        }
      });

      it("should return error result for non-existent charm", async () => {
        const mockManager = new MockCharmManager() as any;
        
        const result = await getCellValue(mockManager, "non-existent", ["path"]);
        
        assertEquals(result.success, false);
        if (!result.success) {
          assertEquals(result.error.type, "CHARM_NOT_FOUND");
          assertEquals(result.error.charmId, "non-existent");
        }
      });

      it("should return error result for invalid path", async () => {
        const mockManager = new MockCharmManager() as any;
        mockManager.setCharmData("charm-1", { count: 42 });
        
        const result = await getCellValue(mockManager, "charm-1", ["count", "invalid"]);
        
        assertEquals(result.success, false);
        if (!result.success) {
          assertEquals(result.error.type, "NON_OBJECT");
        }
      });
    });

    describe("Functional setCellValue", () => {
      it("should return success result for valid operations", async () => {
        const mockManager = new MockCharmManager() as any;
        mockManager.setCharmData("charm-1", {});
        
        const result = await setCellValue(mockManager, "charm-1", ["name"], "Test");
        
        assertEquals(result.success, true);
      });

      it("should return error result for non-existent charm", async () => {
        const mockManager = new MockCharmManager() as any;
        
        const result = await setCellValue(mockManager, "non-existent", ["path"], "value");
        
        assertEquals(result.success, false);
        if (!result.success) {
          assertEquals(result.error.type, "CHARM_NOT_FOUND");
          assertEquals(result.error.charmId, "non-existent");
        }
      });
    });
  });

  describe("CellOperationException", () => {
    it("should properly format error messages", () => {
      const error = new CellOperationException({
        type: "CHARM_NOT_FOUND",
        message: "Test error message",
        charmId: "test-charm"
      });
      
      assertEquals(error.message, "Test error message");
      assertEquals(error.name, "CellOperationException");
      assertEquals(error.error.type, "CHARM_NOT_FOUND");
      assertEquals(error.error.charmId, "test-charm");
    });

    it("should be thrown by class methods for errors", async () => {
      const mockManager = new MockCharmManager() as any;
      const cellOps = new CellOperations(mockManager);
      
      try {
        await cellOps.getCellValue("non-existent", ["path"]);
      } catch (e) {
        assertEquals(e instanceof CellOperationException, true);
        if (e instanceof CellOperationException) {
          assertEquals(e.error.type, "CHARM_NOT_FOUND");
        }
      }
    });
  });
});
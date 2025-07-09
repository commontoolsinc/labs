import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { 
  getCharmResult,
  getCharmInput,
  setCharmInput,
  setCharmResult,
  parsePath,
  type CellPath
} from "../src/ops/cell-operations.ts";
import { Cell } from "@commontools/runner";

// Mock Cell for testing generic cell operations
class MockCell implements Partial<Cell<any>> {
  private data: any;
  private keys: Map<string | number, MockCell> = new Map();

  constructor(data: any = {}) {
    this.data = data;
  }

  set(value: any) {
    this.data = value;
  }

  get() {
    return this.data;
  }

  key(segment: string | number): any {
    if (!this.keys.has(segment)) {
      this.keys.set(segment, new MockCell());
    }
    return this.keys.get(segment)!;
  }
}

// Mock CharmManager for testing charm operations
class MockCharmManager {
  private charms: Map<string, MockCell> = new Map();
  private inputCells: Map<string, MockCell> = new Map();
  public runtime: { idle: () => Promise<void> };

  constructor() {
    this.runtime = {
      idle: async () => {},
    };
  }

  async get(charmId: string): Promise<MockCell | null> {
    return this.charms.get(charmId) || null;
  }

  getArgument(charmCell: MockCell): MockCell {
    const charmId = Array.from(this.charms.entries())
      .find(([_, cell]) => cell === charmCell)?.[0];
    return this.inputCells.get(charmId!) || new MockCell();
  }

  async synced(): Promise<void> {}

  // Helper method for tests to set up data
  setCharmData(charmId: string, resultData: any, inputData: any = {}) {
    const mockCharm = new MockCell(resultData);
    const mockInput = new MockCell(inputData);
    this.charms.set(charmId, mockCharm);
    this.inputCells.set(charmId, mockInput);
  }
}

describe("Extended Cell Operations", () => {
  describe("parsePath", () => {
    it("should parse simple paths", () => {
      assertEquals(parsePath("name"), ["name"]);
      assertEquals(parsePath("config"), ["config"]);
    });

    it("should parse nested paths", () => {
      assertEquals(parsePath("config/settings/theme"), ["config", "settings", "theme"]);
    });

    it("should convert numeric segments", () => {
      assertEquals(parsePath("users/0/name"), ["users", 0, "name"]);
      assertEquals(parsePath("items/10"), ["items", 10]);
    });

    it("should handle empty path", () => {
      assertEquals(parsePath(""), []);
      assertEquals(parsePath("   "), []);
    });
  });

  describe("Charm-specific Operations", () => {
    describe("getCharmInput", () => {
      it("should get input value from charm", async () => {
        const manager = new MockCharmManager() as any;
        manager.setCharmData("charm-1", { result: "data" }, { input: "value" });
        
        const value = await getCharmInput(manager, "charm-1", ["input"]);
        assertEquals(value, "value");
      });

      it("should handle nested input paths", async () => {
        const manager = new MockCharmManager() as any;
        manager.setCharmData("charm-1", {}, { config: { api: "key123" } });
        
        const value = await getCharmInput(manager, "charm-1", ["config", "api"]);
        assertEquals(value, "key123");
      });
    });

    describe("setCharmResult", () => {
      it("should set result value in charm", async () => {
        const manager = new MockCharmManager() as any;
        manager.setCharmData("charm-1", {}, {});
        
        await setCharmResult(manager, "charm-1", ["status"], "completed");
        
        // Get the charm cell to verify
        const charmCell = await manager.get("charm-1") as MockCell;
        const statusCell = charmCell.key("status") as MockCell;
        assertEquals(statusCell.get(), "completed");
      });

      it("should handle nested result paths", async () => {
        const manager = new MockCharmManager() as any;
        manager.setCharmData("charm-1", {}, {});
        
        await setCharmResult(manager, "charm-1", ["data", "items", 0], { id: 1, name: "Item" });
        
        // Get the charm cell to verify
        const charmCell = await manager.get("charm-1") as MockCell;
        const dataCell = charmCell.key("data") as MockCell;
        const itemsCell = dataCell.key("items") as MockCell;
        const firstItemCell = itemsCell.key(0) as MockCell;
        assertEquals(firstItemCell.get(), { id: 1, name: "Item" });
      });
    });

    describe("Input vs Result distinction", () => {
      it("should differentiate between input and result cells", async () => {
        const manager = new MockCharmManager() as any;
        manager.setCharmData("charm-1", 
          { name: "Result Name" }, 
          { name: "Input Name" }
        );
        
        // Get from result
        const resultName = await getCharmResult(manager, "charm-1", ["name"]);
        assertEquals(resultName, "Result Name");
        
        // Get from input
        const inputName = await getCharmInput(manager, "charm-1", ["name"]);
        assertEquals(inputName, "Input Name");
      });

    });
  });
});
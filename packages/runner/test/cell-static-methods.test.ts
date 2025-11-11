import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import { createBuilder } from "../src/builder/factory.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/**
 * Helper to run code within a lift/recipe context (inHandler: false)
 * In this context, cells need explicit causes to create links
 */
function withinLiftContext<T>(
  runtime: Runtime,
  space: string,
  tx: IExtendedStorageTransaction,
  fn: () => T,
): T {
  const frame = {
    runtime,
    space,
    tx,
    cause: { test: "lift context" },
    generatedIdCounter: 0,
    inHandler: false, // Lift/recipe context
    unsafe_binding: { space, tx },
  };

  pushFrame(frame as any);
  try {
    return fn();
  } finally {
    popFrame();
  }
}

/**
 * Helper to run code within a handler context (inHandler: true)
 * In this context, cells can create links without explicit causes
 */
function withinHandlerContext<T>(
  runtime: Runtime,
  space: string,
  tx: IExtendedStorageTransaction,
  fn: () => T,
): T {
  const frame = {
    runtime,
    space,
    tx,
    cause: { test: "handler context" },
    generatedIdCounter: 0,
    inHandler: true, // Handler context - allows cells to create links
    unsafe_binding: { space, tx },
  };

  pushFrame(frame as any);
  try {
    return fn();
  } finally {
    popFrame();
  }
}

describe("Cell Static Methods", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let Cell: ReturnType<typeof createBuilder>["commontools"]["Cell"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder(runtime);
    ({ Cell } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Cell.of()", () => {
    it("should create a cell with a primitive value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(42);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(42);
      });
    });

    it("should create a cell with a string value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of("hello");
        expect(cell).toBeDefined();
        expect(cell.get()).toBe("hello");
      });
    });

    it("should create a cell with an object value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const obj = { x: 1, y: 2 };
        const cell = Cell.of(obj);
        expect(cell).toBeDefined();
        expect(cell.get()).toEqual(obj);
      });
    });

    it("should create a cell with an array value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const arr = [1, 2, 3];
        const cell = Cell.of(arr);
        expect(cell).toBeDefined();
        expect(cell.get()).toEqual(arr);
      });
    });

    it("should create a cell with null value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(null);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(null);
      });
    });

    it("should create a cell with undefined value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(undefined);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(undefined);
      });
    });

    it("should create a cell with boolean value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(true);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(true);
      });
    });

    it("should create cells with different types", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const numCell = Cell.of(123);
        const strCell = Cell.of("test");
        const objCell = Cell.of({ a: 1 });

        expect(numCell.get()).toBe(123);
        expect(strCell.get()).toBe("test");
        expect(objCell.get()).toEqual({ a: 1 });
      });
    });

    it("should allow updating the cell after creation", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(10);
        expect(cell.get()).toBe(10);

        cell.set(20);
        expect(cell.get()).toBe(20);
      });
    });

    it("should preserve complex nested objects", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const complex = {
          name: "test",
          nested: {
            array: [1, 2, 3],
            bool: true,
          },
        };
        const cell = Cell.of(complex);
        expect(cell.get()).toEqual(complex);
      });
    });

    it("should accept a schema as second parameter", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const schema = { type: "string" as const, minLength: 3 };
        const cell = Cell.of("hello", schema);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe("hello");
      });
    });

    it("should merge value into provided schema", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const schema = { type: "number" as const, minimum: 0, maximum: 100 };
        const cell = Cell.of(42, schema);
        expect(cell).toBeDefined();
        expect(cell.get()).toBe(42);
      });
    });

    it("should handle complex schema with value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const schema = {
          type: "object" as const,
          properties: {
            name: { type: "string" as const },
            age: { type: "number" as const },
          },
          required: ["name"],
        };
        const value = { name: "Alice", age: 30 };
        const cell = Cell.of(value, schema);
        expect(cell).toBeDefined();
        expect(cell.get()).toEqual(value);
      });
    });
  });

  describe("Cell.for()", () => {
    it("should create a cell with a cause", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cause = { id: "test-cause" };
        const cell = Cell.for(cause);
        expect(cell).toBeDefined();
      });
    });

    it("should create a cell with string cause", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for("my-cause");
        expect(cell).toBeDefined();
      });
    });

    it("should create a cell with object cause", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cause = { type: "user-action", id: 123 };
        const cell = Cell.for(cause);
        expect(cell).toBeDefined();
      });
    });

    it("should create cells with different causes", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell1 = Cell.for("cause1");
        const cell2 = Cell.for("cause2");

        expect(cell1).toBeDefined();
        expect(cell2).toBeDefined();
        // They should be different cells
        expect(cell1).not.toBe(cell2);
      });
    });

    it("should allow setting values on cell created with .for()", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for<number>("test");
        cell.set(42);
        expect(cell.get()).toBe(42);
      });
    });

    it("should support chaining .for() with value assignment", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for<string>("cause");
        cell.set("value");
        expect(cell.get()).toBe("value");
      });
    });

    it("should support chaining .for() with .asSchema()", () => {
      withinLiftContext(runtime, space, tx, () => {
        const schema = { type: "string" as const, minLength: 3 };
        const cell = Cell.for("my-cause").asSchema(schema);
        expect(cell).toBeDefined();
      });
    });
  });

  describe("Cell.equals()", () => {
    it("should return true for the same cell", () => {
      const cell = runtime.getCell<number>(
        space,
        "test-cell",
        undefined,
        tx,
      );
      expect(Cell.equals(cell, cell)).toBe(true);
    });

    it("should return false for different cells", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "cell1",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "cell2",
        undefined,
        tx,
      );
      expect(Cell.equals(cell1, cell2)).toBe(false);
    });

    it("should return true for cells with same link", () => {
      const cell1 = runtime.getCell<number>(
        space,
        "same-link",
        undefined,
        tx,
      );
      const cell2 = runtime.getCell<number>(
        space,
        "same-link",
        undefined,
        tx,
      );
      expect(Cell.equals(cell1, cell2)).toBe(true);
    });

    it("should handle comparison with non-cell objects", () => {
      const cell = runtime.getCell<number>(
        space,
        "test",
        undefined,
        tx,
      );
      const obj = { some: "object" };
      // Should not throw, returns false
      expect(Cell.equals(cell, obj)).toBe(false);
    });

    it("should handle comparison of two plain objects", () => {
      const obj1 = { a: 1 };
      const obj2 = { a: 1 };
      // Plain objects are not cells, so equals should return false
      expect(Cell.equals(obj1, obj2)).toBe(false);
    });

    it("should handle null and undefined", () => {
      const cell = runtime.getCell<number>(
        space,
        "test",
        undefined,
        tx,
      );
      expect(Cell.equals(cell, null as any)).toBe(false);
      expect(Cell.equals(null as any, cell)).toBe(false);
    });
  });

  describe("Integration tests", () => {
    it("should work with Cell.of() and Cell.equals()", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell1 = Cell.of(100);
        const cell2 = Cell.of(100);

        // Different cells even with same value
        expect(Cell.equals(cell1, cell2)).toBe(false);

        // Same cell reference
        expect(Cell.equals(cell1, cell1)).toBe(true);
      });
    });

    it("should combine .of() and then update value", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of(
          { count: 0 },
          {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          } as const satisfies JSONSchema,
        );
        expect(cell.get()).toEqual({ count: 0 });

        cell.update({ count: 1 });
        expect(cell.get()).toEqual({ count: 1 });
      });
    });

    it("should work with arrays using .of()", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of([1, 2, 3]);
        expect(cell.get()).toEqual([1, 2, 3]);

        cell.push(4);
        expect(cell.get()).toEqual([1, 2, 3, 4]);
      });
    });

    it("should allow .for() followed by value operations", () => {
      withinLiftContext(runtime, space, tx, () => {
        const cell = Cell.for<{ name: string }>("user-cell");
        cell.set({ name: "Alice" });

        expect(cell.get()).toEqual({ name: "Alice" });

        cell.update({ name: "Bob" });
        expect(cell.get()).toEqual({ name: "Bob" });
      });
    });

    it("should handle type inference with .of()", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // TypeScript should infer the type
        const numCell = Cell.of(42);
        const strCell = Cell.of("hello");
        const objCell = Cell.of({ x: 1, y: 2 });

        // These should all work without type errors
        numCell.set(100);
        strCell.set("world");
        objCell.set({ x: 10, y: 20 });
      });
    });

    it("should support explicit type parameters with .for()", () => {
      withinLiftContext(runtime, space, tx, () => {
        interface User {
          id: number;
          name: string;
        }

        const userCell = Cell.for<User>("user");
        userCell.set({ id: 1, name: "Test" });

        expect(userCell.get()).toEqual({ id: 1, name: "Test" });
      });
    });
  });

  describe("Edge cases", () => {
    it("should handle creating cell with very large numbers", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const largeNum = Number.MAX_SAFE_INTEGER;
        const cell = Cell.of(largeNum);
        expect(cell.get()).toBe(largeNum);
      });
    });

    it("should handle creating cell with special number values", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const nanCell = Cell.of(NaN);
        const infCell = Cell.of(Infinity);
        const negInfCell = Cell.of(-Infinity);

        expect(Number.isNaN(nanCell.get())).toBe(true);
        expect(infCell.get()).toBe(Infinity);
        expect(negInfCell.get()).toBe(-Infinity);
      });
    });

    it("should handle creating cell with empty string", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of("");
        expect(cell.get()).toBe("");
      });
    });

    it("should handle creating cell with empty array", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of([]);
        expect(cell.get()).toEqual([]);
      });
    });

    it("should handle creating cell with empty object", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const cell = Cell.of({});
        expect(cell.get()).toEqual({});
      });
    });

    it("should handle deeply nested structures", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const deep = {
          level1: {
            level2: {
              level3: {
                level4: {
                  value: "deep",
                },
              },
            },
          },
        };
        const cell = Cell.of(deep);
        expect(cell.get()).toEqual(deep);
      });
    });

    it("should handle creating cell with Date object", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const date = new Date("2024-01-01");
        const cell = Cell.of(date);
        expect(cell.get()).toEqual(date);
      });
    });

    it("should handle creating cell with mixed type array", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const mixed = [1, "two", { three: 3 }, [4], true, null];
        const cell = Cell.of(mixed);
        expect(cell.get()).toEqual(mixed);
      });
    });
  });
});

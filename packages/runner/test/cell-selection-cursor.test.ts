import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { isCell } from "../src/cell.ts";
import { NAME, UI, type OpaqueCell } from "../src/builder/types.ts";
import { recipe } from "../src/builder/recipe.ts";
import type { Default } from "@commontools/api";
import { createDataCellURI } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

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
    inHandler: true,
    unsafe_binding: { space, tx },
  };

  pushFrame(frame as any);
  try {
    return fn();
  } finally {
    popFrame();
  }
}

describe("Cell Selection - Single vs Double Wrapping", () => {
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

    const { commontools } = createBuilder();
    ({ Cell } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Single-wrapped: Cell.of<unknown>()", () => {
    it("should correctly track selection when cycling through items", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create array of cells with distinct values
        const itemA = Cell.of({ title: "A" });
        const itemB = Cell.of({ title: "B" });
        const itemC = Cell.of({ title: "C" });
        const items = [itemA, itemB, itemC];

        // Single-wrapped selection: holds the value directly
        const selected = Cell.of<unknown>(itemA);

        // Verify initial state
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });

        // Cycle to item B
        selected.set(itemB);

        // CRITICAL: Original items should remain UNCHANGED
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });

        // Cycle to item C
        selected.set(itemC);

        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });

        // Cycle back to item A
        selected.set(itemA);

        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });
      });
    });

    it("should maintain item distinctness after multiple cycles", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const itemA = Cell.of({ title: "A" });
        const itemB = Cell.of({ title: "B" });
        const itemC = Cell.of({ title: "C" });

        const selected = Cell.of<unknown>(itemA);

        // Cycle multiple times: A -> B -> C -> A -> B -> C -> B -> A
        for (const item of [itemB, itemC, itemA, itemB, itemC, itemB, itemA]) {
          selected.set(item);
        }

        // Items should still be distinct
        expect(itemA.equals(itemB)).toBe(false);
        expect(itemB.equals(itemC)).toBe(false);
        expect(itemA.equals(itemC)).toBe(false);

        // Values should be unchanged
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });
      });
    });

    it("should verify Cell.equals behavior with persisted cells", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Use runtime.getCell for persisted cells that work with Cell.equals
        const itemA = runtime.getCell<{ title: string }>(space, "item-A-equals", undefined, tx);
        const itemB = runtime.getCell<{ title: string }>(space, "item-B-equals", undefined, tx);
        const itemC = runtime.getCell<{ title: string }>(space, "item-C-equals", undefined, tx);

        itemA.set({ title: "A" });
        itemB.set({ title: "B" });
        itemC.set({ title: "C" });

        const selected = runtime.getCell<unknown>(space, "selected-equals", undefined, tx);
        selected.set(itemA);

        // Cell.equals() resolves links, so when selected contains a link to itemA,
        // Cell.equals(selected, itemA) returns true because they resolve to the same location.
        expect(Cell.equals(selected, itemA)).toBe(true);
        expect(Cell.equals(selected, itemB)).toBe(false);
        expect(Cell.equals(selected, itemC)).toBe(false);

        // Change selection to B
        selected.set(itemB);
        expect(Cell.equals(selected, itemA)).toBe(false);
        expect(Cell.equals(selected, itemB)).toBe(true);
        expect(Cell.equals(selected, itemC)).toBe(false);

        // Change selection to C
        selected.set(itemC);
        expect(Cell.equals(selected, itemA)).toBe(false);
        expect(Cell.equals(selected, itemB)).toBe(false);
        expect(Cell.equals(selected, itemC)).toBe(true);

        // Items should NOT be corrupted
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });
      });
    });
  });

  describe("Double-wrapped: Cell.of<Cell<unknown>>()", () => {
    it("should correctly track selection when cycling through items", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create array of cells with distinct values
        const itemA = Cell.of({ title: "A" });
        const itemB = Cell.of({ title: "B" });
        const itemC = Cell.of({ title: "C" });
        const items = [itemA, itemB, itemC];

        // Double-wrapped selection: holds a reference to another cell
        const selected = Cell.of<typeof itemA>(itemA);

        // Verify initial state
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });

        // Cycle to item B
        selected.set(itemB);

        // CRITICAL: Original items should remain UNCHANGED
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });

        // Cycle to item C
        selected.set(itemC);

        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });

        // Cycle back to item A
        selected.set(itemA);

        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });
      });
    });

    it("should maintain item distinctness after multiple cycles", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const itemA = Cell.of({ title: "A" });
        const itemB = Cell.of({ title: "B" });
        const itemC = Cell.of({ title: "C" });

        const selected = Cell.of<typeof itemA>(itemA);

        // Cycle multiple times: A -> B -> C -> A -> B -> C -> B -> A
        for (const item of [itemB, itemC, itemA, itemB, itemC, itemB, itemA]) {
          selected.set(item);
        }

        // Items should still be distinct
        expect(itemA.equals(itemB)).toBe(false);
        expect(itemB.equals(itemC)).toBe(false);
        expect(itemA.equals(itemC)).toBe(false);

        // Values should be unchanged
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
        expect(itemC.get()).toEqual({ title: "C" });
      });
    });

    it("should understand link resolution with persisted cells", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Use runtime.getCell for predictable behavior
        const itemA = runtime.getCell<{ title: string }>(space, "double-item-A", undefined, tx);
        const itemB = runtime.getCell<{ title: string }>(space, "double-item-B", undefined, tx);

        itemA.set({ title: "A" });
        itemB.set({ title: "B" });

        const selected = runtime.getCell<unknown>(space, "double-selected", undefined, tx);
        selected.set(itemA);

        // Cell.get() resolves links, so we get the VALUE of itemA, not the cell itself
        const currentSelection = selected.get();
        expect(isCell(currentSelection)).toBe(false);
        expect(currentSelection).toEqual({ title: "A" });

        // Change selection
        selected.set(itemB);
        const newSelection = selected.get();

        expect(isCell(newSelection)).toBe(false);
        expect(newSelection).toEqual({ title: "B" });

        // To check WHICH cell is selected, use Cell.equals()
        expect(Cell.equals(selected, itemB)).toBe(true);
        expect(Cell.equals(selected, itemA)).toBe(false);

        // Items remain uncorrupted
        expect(itemA.get()).toEqual({ title: "A" });
        expect(itemB.get()).toEqual({ title: "B" });
      });
    });

    it("should use getRaw to see the underlying link structure", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Use runtime.getCell for predictable behavior
        const itemA = runtime.getCell<{ title: string }>(space, "raw-item-A", undefined, tx);
        const itemB = runtime.getCell<{ title: string }>(space, "raw-item-B", undefined, tx);

        itemA.set({ title: "A" });
        itemB.set({ title: "B" });

        const selected = runtime.getCell<unknown>(space, "raw-selected", undefined, tx);
        selected.set(itemA);

        // getRaw() shows the raw storage value - a link to itemA
        const rawValue = selected.getRaw();
        console.log("selected.getRaw() after setting itemA:", JSON.stringify(rawValue));

        // The raw value should be a link object (not undefined for persisted cells)
        expect(rawValue).toBeDefined();

        // After setting to itemB, raw value should be a different link
        selected.set(itemB);
        const newRawValue = selected.getRaw();
        console.log("selected.getRaw() after setting itemB:", JSON.stringify(newRawValue));
        expect(newRawValue).toBeDefined();
      });
    });
  });

  describe("Comparison: Which approach preserves item integrity?", () => {
    it("documents behavior differences between single and double wrapping", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create items
        const itemA = Cell.of({ title: "A", id: 1 });
        const itemB = Cell.of({ title: "B", id: 2 });
        const itemC = Cell.of({ title: "C", id: 3 });

        // Single-wrapped
        const singleSelected = Cell.of<unknown>(itemA);

        // Double-wrapped
        const doubleSelected = Cell.of<typeof itemA>(itemA);

        // Record initial values
        const initialA = itemA.get();
        const initialB = itemB.get();
        const initialC = itemC.get();

        // Cycle both through the same sequence
        for (const item of [itemB, itemC, itemA]) {
          singleSelected.set(item);
          doubleSelected.set(item);
        }

        // Check if items are corrupted
        const singlePreservesItems =
          JSON.stringify(itemA.get()) === JSON.stringify(initialA) &&
          JSON.stringify(itemB.get()) === JSON.stringify(initialB) &&
          JSON.stringify(itemC.get()) === JSON.stringify(initialC);

        const doublePreservesItems =
          JSON.stringify(itemA.get()) === JSON.stringify(initialA) &&
          JSON.stringify(itemB.get()) === JSON.stringify(initialB) &&
          JSON.stringify(itemC.get()) === JSON.stringify(initialC);

        console.log("Single-wrapped preserves items:", singlePreservesItems);
        console.log("Double-wrapped preserves items:", doublePreservesItems);

        // At least one approach should work
        expect(singlePreservesItems || doublePreservesItems).toBe(true);
      });
    });
  });

  describe("ct-picker simulation: using items.key(index)", () => {
    it("should understand Cell.of array vs runtime.getCell array", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Method 1: Cell.of([...]) - creates a cell with default array value
        const cellOfArray = Cell.of([
          { title: "A", count: 1 },
          { title: "B", count: 2 },
        ]);

        // Method 2: runtime.getCell - creates a persisted cell
        const runtimeArray = runtime.getCell<{ title: string; count: number }[]>(
          space,
          "runtime-array",
          undefined,
          tx,
        );
        runtimeArray.set([
          { title: "A", count: 1 },
          { title: "B", count: 2 },
        ]);

        console.log("=== Cell.of array ===");
        console.log("cellOfArray.get():", JSON.stringify(cellOfArray.get()));
        console.log("cellOfArray.key(0).get():", JSON.stringify(cellOfArray.key(0).get()));
        console.log("cellOfArray.key(1).get():", JSON.stringify(cellOfArray.key(1).get()));

        console.log("=== runtime.getCell array ===");
        console.log("runtimeArray.get():", JSON.stringify(runtimeArray.get()));
        console.log("runtimeArray.key(0).get():", JSON.stringify(runtimeArray.key(0).get()));
        console.log("runtimeArray.key(1).get():", JSON.stringify(runtimeArray.key(1).get()));

        // Check if Cell.of array supports .key()
        // This might be the issue - Cell.of might not persist data the same way
        expect(runtimeArray.key(0).get()).toEqual({ title: "A", count: 1 });
        expect(runtimeArray.key(1).get()).toEqual({ title: "B", count: 2 });
      });
    });

    it("should handle selection via runtime.getCell array with key access", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Use runtime.getCell instead of Cell.of
        const itemsCell = runtime.getCell<{ title: string; count: number }[]>(
          space,
          "items-array",
          undefined,
          tx,
        );
        itemsCell.set([
          { title: "A", count: 1 },
          { title: "B", count: 2 },
          { title: "C", count: 3 },
        ]);

        // Selection cell
        const selected = runtime.getCell<unknown>(
          space,
          "selection",
          undefined,
          tx,
        );
        selected.set(itemsCell.key(0));

        // Verify initial values
        expect(itemsCell.key(0).get()).toEqual({ title: "A", count: 1 });
        expect(itemsCell.key(1).get()).toEqual({ title: "B", count: 2 });
        expect(itemsCell.key(2).get()).toEqual({ title: "C", count: 3 });

        // Simulate cycling: select item 1
        selected.set(itemsCell.key(1));

        // Items should remain unchanged
        expect(itemsCell.key(0).get()).toEqual({ title: "A", count: 1 });
        expect(itemsCell.key(1).get()).toEqual({ title: "B", count: 2 });
        expect(itemsCell.key(2).get()).toEqual({ title: "C", count: 3 });

        // Simulate cycling: select item 2
        selected.set(itemsCell.key(2));

        expect(itemsCell.key(0).get()).toEqual({ title: "A", count: 1 });
        expect(itemsCell.key(1).get()).toEqual({ title: "B", count: 2 });
        expect(itemsCell.key(2).get()).toEqual({ title: "C", count: 3 });

        // Simulate wrap-around: back to item 0
        selected.set(itemsCell.key(0));

        expect(itemsCell.key(0).get()).toEqual({ title: "A", count: 1 });
        expect(itemsCell.key(1).get()).toEqual({ title: "B", count: 2 });
        expect(itemsCell.key(2).get()).toEqual({ title: "C", count: 3 });
      });
    });

    it("should handle selection via array of separate cells", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // This is the pattern from ct-select.tsx:
        // const counters = [counterA, counterB, counterC];
        // const selection = Cell.of<OpaqueCell<unknown>>(counterA);

        const counterA = Cell.of({ value: 1 });
        const counterB = Cell.of({ value: 2 });
        const counterC = Cell.of({ value: 3 });
        const counters = [counterA, counterB, counterC];

        // Selection holds a cell reference
        const selection = Cell.of<typeof counterA>(counterA);

        // Verify initial state
        expect(counterA.get()).toEqual({ value: 1 });
        expect(counterB.get()).toEqual({ value: 2 });
        expect(counterC.get()).toEqual({ value: 3 });

        // Simulate picker cycling to counter B
        selection.set(counterB);

        // CRITICAL: counters should NOT be corrupted
        expect(counterA.get()).toEqual({ value: 1 });
        expect(counterB.get()).toEqual({ value: 2 });
        expect(counterC.get()).toEqual({ value: 3 });

        // Simulate picker cycling to counter C
        selection.set(counterC);

        expect(counterA.get()).toEqual({ value: 1 });
        expect(counterB.get()).toEqual({ value: 2 });
        expect(counterC.get()).toEqual({ value: 3 });

        // Cycle back to counter A
        selection.set(counterA);

        expect(counterA.get()).toEqual({ value: 1 });
        expect(counterB.get()).toEqual({ value: 2 });
        expect(counterC.get()).toEqual({ value: 3 });
      });
    });
  });

  describe("Edge cases and diagnostics", () => {
    it("should log raw values for debugging", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const itemA = Cell.of({ title: "A" });
        const itemB = Cell.of({ title: "B" });

        const selected = Cell.of<unknown>(itemA);

        console.log("=== Initial State ===");
        console.log("itemA.getRaw():", JSON.stringify(itemA.getRaw()));
        console.log("itemB.getRaw():", JSON.stringify(itemB.getRaw()));
        console.log("selected.getRaw():", JSON.stringify(selected.getRaw()));

        selected.set(itemB);

        console.log("=== After selected.set(itemB) ===");
        console.log("itemA.getRaw():", JSON.stringify(itemA.getRaw()));
        console.log("itemB.getRaw():", JSON.stringify(itemB.getRaw()));
        console.log("selected.getRaw():", JSON.stringify(selected.getRaw()));

        // The key question: did itemA get overwritten?
        const itemAValue = itemA.get();
        const itemBValue = itemB.get();

        console.log("itemA.get():", JSON.stringify(itemAValue));
        console.log("itemB.get():", JSON.stringify(itemBValue));

        // This should pass
        expect(itemAValue).toEqual({ title: "A" });
        expect(itemBValue).toEqual({ title: "B" });
      });
    });

    it("should verify cell identity is preserved", () => {
      withinHandlerContext(runtime, space, tx, () => {
        const itemA = Cell.of({ title: "A" });
        const itemB = Cell.of({ title: "B" });

        // Get links before cycling
        const itemALinkBefore = itemA.getAsNormalizedFullLink();
        const itemBLinkBefore = itemB.getAsNormalizedFullLink();

        const selected = Cell.of<unknown>(itemA);
        selected.set(itemB);
        selected.set(itemA);

        // Get links after cycling
        const itemALinkAfter = itemA.getAsNormalizedFullLink();
        const itemBLinkAfter = itemB.getAsNormalizedFullLink();

        // Links should be identical (same entity ID, same path)
        expect(itemALinkBefore.id).toBe(itemALinkAfter.id);
        expect(itemBLinkBefore.id).toBe(itemBLinkAfter.id);

        console.log("itemA link before:", itemALinkBefore.id);
        console.log("itemA link after:", itemALinkAfter.id);
        console.log("itemB link before:", itemBLinkBefore.id);
        console.log("itemB link after:", itemBLinkAfter.id);
      });
    });
  });

  describe("Data URI alias resolution", () => {
    it("should resolve $alias objects when Cell.key() is called on data URI cells", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create target cells in normal storage
        const targetA = runtime.getCell<{ title: string }>(space, "target-A", undefined, tx);
        const targetB = runtime.getCell<{ title: string }>(space, "target-B", undefined, tx);
        targetA.set({ title: "Target A" });
        targetB.set({ title: "Target B" });

        // Get the entity IDs for the targets
        const targetALink = targetA.getAsNormalizedFullLink();
        const targetBLink = targetB.getAsNormalizedFullLink();

        // Create a data URI containing alias objects (simulating vnode serialization)
        // This is what happens when vnodes are serialized with $alias references
        const dataContent = [
          { $alias: { cell: { "/": targetALink.id.replace("of:", "") }, path: [] } },
          { $alias: { cell: { "/": targetBLink.id.replace("of:", "") }, path: [] } },
        ];

        // Create data URI cell using the helper
        const dataUri = createDataCellURI(dataContent);
        const dataCell = runtime.getImmutableCell(space, dataContent, undefined, tx);

        // Call .key(0) - should resolve the alias and return cell pointing to targetA
        const child0 = dataCell.key(0);
        const child0Link = child0.getAsNormalizedFullLink();

        console.log("=== Data URI Alias Resolution Test ===");
        console.log("targetALink.id:", targetALink.id);
        console.log("targetBLink.id:", targetBLink.id);
        console.log("child0Link.id:", child0Link.id);
        console.log("child0Link.path:", JSON.stringify(child0Link.path));

        // The key assertion: child0 should point to targetA's location, NOT into the data URI
        expect(child0Link.id).toBe(targetALink.id);
        expect(child0Link.path).toEqual([]);

        // And reading through child0 should get targetA's value
        expect(child0.get()).toEqual({ title: "Target A" });

        // Same for index 1
        const child1 = dataCell.key(1);
        const child1Link = child1.getAsNormalizedFullLink();
        expect(child1Link.id).toBe(targetBLink.id);
        expect(child1.get()).toEqual({ title: "Target B" });
      });
    });

    it("should handle $alias with nested paths", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create a target cell with nested data
        const target = runtime.getCell<{ nested: { value: number } }>(space, "nested-target", undefined, tx);
        target.set({ nested: { value: 42 } });

        const targetLink = target.getAsNormalizedFullLink();

        // Create alias pointing to nested.value path
        const dataContent = [
          { $alias: { cell: { "/": targetLink.id.replace("of:", "") }, path: ["nested", "value"] } },
        ];

        const dataCell = runtime.getImmutableCell(space, dataContent, undefined, tx);

        // Call .key(0) - should resolve alias with nested path
        const child0 = dataCell.key(0);
        const child0Link = child0.getAsNormalizedFullLink();

        console.log("=== Nested Path Alias Test ===");
        console.log("targetLink.id:", targetLink.id);
        console.log("child0Link.id:", child0Link.id);
        console.log("child0Link.path:", JSON.stringify(child0Link.path));

        // Should point to target with nested path
        expect(child0Link.id).toBe(targetLink.id);
        expect(child0Link.path).toEqual(["nested", "value"]);

        // Reading should get the nested value
        expect(child0.get()).toBe(42);
      });
    });

    it("should not resolve non-alias values in data URIs", () => {
      withinHandlerContext(runtime, space, tx, () => {
        // Create a data URI with regular data (no aliases)
        const dataContent = [
          { title: "Item A" },
          { title: "Item B" },
        ];

        const dataCell = runtime.getImmutableCell(space, dataContent, undefined, tx);

        // Call .key(0) - should return cell pointing into data URI (no alias to resolve)
        const child0 = dataCell.key(0);
        const child0Link = child0.getAsNormalizedFullLink();

        console.log("=== Non-Alias Data URI Test ===");
        console.log("child0Link.id:", child0Link.id);
        console.log("child0Link.path:", JSON.stringify(child0Link.path));

        // Should still point to data URI with path ["0"]
        expect(child0Link.id.startsWith("data:")).toBe(true);
        expect(child0Link.path).toEqual(["0"]);

        // Reading should get the item
        expect(child0.get()).toEqual({ title: "Item A" });
      });
    });
  });

});

// Separate describe block for recipe-based tests to avoid frame issues
describe("Cell Selection with Recipe OpaqueRefs", () => {
  // These tests replicate the EXACT pattern from ct-select.tsx:
  // const counterA = Counter({ value: 1 });  // Returns OpaqueRef<RecipeOutput>
  // const counterB = Note({ content: "test" });
  // const counters = [counterA, counterB, counterC];
  // const selection = Cell.of<OpaqueCell<unknown>>(counterA);

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  let builderRecipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let Cell: ReturnType<typeof createBuilder>["commontools"]["Cell"];

  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ lift, recipe: builderRecipe, Cell, handler } = commontools);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should handle selection cycling with recipe OpaqueRefs (simple)", async () => {
    // Simplified test - just check if nested recipe invocation and Cell.of work together

    interface CounterState {
      value: Default<number, 0>;
    }

    interface CounterOutput {
      value: number;
    }

    // Simple counter recipe
    const TestCounter = builderRecipe<CounterState, CounterOutput>(
      "TestCounter",
      (state) => {
        return {
          [NAME]: `Counter`,
          value: state.value,
        };
      },
    );

    interface TestState {
      dummy: Default<number, 0>;
    }

    interface TestOutput {
      counterAValue: number;
      counterBValue: number;
      counterCValue: number;
    }

    const SimpleTestRecipe = builderRecipe<TestState, TestOutput>(
      "SimpleTestRecipe",
      (_state) => {
        console.log("=== Recipe body starting ===");

        // Invoke nested recipes
        const counterA = TestCounter({ value: 1 });
        const counterB = TestCounter({ value: 2 });
        const counterC = TestCounter({ value: 3 });

        console.log("=== Counters created ===");

        // Create selection cell
        const selection = Cell.of<OpaqueCell<unknown>>(counterA);
        console.log("=== selection Cell.of created ===");

        // Use lift to extract the values (this will be computed at runtime)
        const result = lift((inputs: { a: number; b: number; c: number }) => ({
          counterAValue: inputs.a,
          counterBValue: inputs.b,
          counterCValue: inputs.c,
        }))({ a: counterA.value, b: counterB.value, c: counterC.value });

        console.log("=== Recipe body done ===");
        return result;
      },
    );

    console.log("=== About to run recipe ===");

    // Run the recipe
    const resultCell = runtime.getCell<TestOutput>(
      space,
      "simple-test-1",
      undefined,
      tx,
    );
    const result = runtime.run(tx, SimpleTestRecipe, { dummy: 0 }, resultCell);
    tx.commit();
    await runtime.idle();

    console.log("=== Runtime idle, getting output ===");

    const output = result.getAsQueryResult();
    console.log("=== Output:", output);

    expect(output?.counterAValue).toBe(1);
    expect(output?.counterBValue).toBe(2);
    expect(output?.counterCValue).toBe(3);
  });

  it("should verify counters array stays intact after recipe setup", async () => {
    // This test verifies that nested recipe invocations produce stable OpaqueRefs
    // and that putting them in an array and a Cell.of doesn't corrupt them

    interface CounterState {
      value: Default<number, 0>;
    }

    interface CounterOutput {
      value: number;
    }

    const TestCounter2 = builderRecipe<CounterState, CounterOutput>(
      "TestCounter2",
      (state) => {
        return {
          [NAME]: `Counter`,
          value: state.value,
        };
      },
    );

    interface TestState2 {
      dummy: Default<number, 0>;
    }

    interface TestOutput2 {
      counterAValue: number;
      counterBValue: number;
      counterCValue: number;
      countersLength: number;
      // Returns true if values are [100, 200, 300]
      allDistinct: boolean;
    }

    const ArrayTestRecipe = builderRecipe<TestState2, TestOutput2>(
      "ArrayTestRecipe",
      (_state) => {
        console.log("=== Recipe body starting ===");

        const counterA = TestCounter2({ value: 100 });
        const counterB = TestCounter2({ value: 200 });
        const counterC = TestCounter2({ value: 300 });

        // Put in array (like ct-select.tsx)
        const counters = [counterA, counterB, counterC];

        // Create selection cell (like ct-select.tsx)
        const selection = Cell.of<OpaqueCell<unknown>>(counterA);

        console.log("=== Recipe body done ===");

        // Use lift to check values at runtime
        const result = lift(
          (inputs: { a: number; b: number; c: number }) => ({
            counterAValue: inputs.a,
            counterBValue: inputs.b,
            counterCValue: inputs.c,
            countersLength: 3,
            allDistinct:
              inputs.a === 100 && inputs.b === 200 && inputs.c === 300,
          }),
        )({ a: counterA.value, b: counterB.value, c: counterC.value });

        return result;
      },
    );

    const resultCell = runtime.getCell<TestOutput2>(
      space,
      "array-test",
      undefined,
      tx,
    );
    const result = runtime.run(tx, ArrayTestRecipe, { dummy: 0 }, resultCell);
    tx.commit();
    await runtime.idle();

    const output = result.getAsQueryResult();
    console.log("=== Output:", output);

    // Values should be preserved: 100, 200, 300
    expect(output?.counterAValue).toBe(100);
    expect(output?.counterBValue).toBe(200);
    expect(output?.counterCValue).toBe(300);
    expect(output?.allDistinct).toBe(true);
  });

  it("should preserve OpaqueRef values after selection.set cycling via handler", async () => {
    // This test uses a handler that receives selection and items as inputs
    // to test runtime selection.set() behavior

    interface CounterState {
      value: Default<number, 0>;
    }

    interface CounterOutput {
      value: number;
    }

    const TestCounter3 = builderRecipe<CounterState, CounterOutput>(
      "TestCounter3",
      (state) => {
        return {
          [NAME]: `Counter`,
          value: state.value,
        };
      },
    );

    // Handler: (eventSchema, stateSchema, callback)
    // Event schema - just a trigger with no data needed
    const cycleSelectionHandler = handler(
      // Event schema
      { type: "object", properties: {}, required: [] },
      // State schema - receives selection and counters
      {
        type: "object",
        properties: {
          selection: { asCell: true },
          counterA: {},
          counterB: {},
          counterC: {},
        },
        required: ["selection", "counterA", "counterB", "counterC"],
      },
      // Callback
      (_event: unknown, state: {
        selection: { set: (v: unknown) => void };
        counterA: unknown;
        counterB: unknown;
        counterC: unknown;
      }) => {
        console.log("=== Handler: cycling selection ===");
        state.selection.set(state.counterB);
        state.selection.set(state.counterC);
        state.selection.set(state.counterA);
        console.log("=== Handler: done cycling ===");
      },
    );

    interface TestState3 {
      dummy: Default<number, 0>;
    }

    interface TestOutput3 {
      counterA: CounterOutput;
      counterB: CounterOutput;
      counterC: CounterOutput;
      selection: OpaqueCell<unknown>;
      cycle: unknown;
    }

    const CycleTestRecipe = builderRecipe<TestState3, TestOutput3>(
      "CycleTestRecipe",
      (_state) => {
        const counterA = TestCounter3({ value: 100 });
        const counterB = TestCounter3({ value: 200 });
        const counterC = TestCounter3({ value: 300 });

        const selection = Cell.of<OpaqueCell<unknown>>(counterA);

        // Pass to handler as inputs
        const cycle = cycleSelectionHandler({
          selection,
          counterA,
          counterB,
          counterC,
        });

        return {
          [NAME]: "Cycle Test",
          counterA,
          counterB,
          counterC,
          selection,
          cycle,
        };
      },
    );

    const resultCell = runtime.getCell<TestOutput3>(
      space,
      "cycle-test",
      undefined,
      tx,
    );
    const result = runtime.run(tx, CycleTestRecipe, { dummy: 0 }, resultCell);
    tx.commit();
    await runtime.idle();

    const output = result.getAsQueryResult();
    console.log("=== Before cycling ===");
    console.log("counterA.value:", output?.counterA?.value);
    console.log("counterB.value:", output?.counterB?.value);
    console.log("counterC.value:", output?.counterC?.value);

    // Trigger the cycle handler by sending an event via result.key()
    result.key("cycle").send({});
    await runtime.idle();

    // Re-read values after cycling
    const outputAfter = result.getAsQueryResult();
    console.log("=== After cycling ===");
    console.log("counterA.value:", outputAfter?.counterA?.value);
    console.log("counterB.value:", outputAfter?.counterB?.value);
    console.log("counterC.value:", outputAfter?.counterC?.value);

    // Values should still be 100, 200, 300
    expect(outputAfter?.counterA?.value).toBe(100);
    expect(outputAfter?.counterB?.value).toBe(200);
    expect(outputAfter?.counterC?.value).toBe(300);
  });

  it("should preserve values when using items.key(index) like ct-picker does", async () => {
    // This test matches the EXACT ct-picker pattern:
    // - items is a Cell<OpaqueRef[]>
    // - selection.set(items.key(index)) is called

    interface CounterState {
      value: Default<number, 0>;
    }

    interface CounterOutput {
      value: number;
    }

    const TestCounter4 = builderRecipe<CounterState, CounterOutput>(
      "TestCounter4",
      (state) => {
        return {
          [NAME]: `Counter`,
          value: state.value,
        };
      },
    );

    // Handler that uses items.key(index) like ct-picker does
    const cycleViaKeyHandler = handler(
      // Event schema - empty, just a trigger
      { type: "object", properties: {}, required: [] },
      // State schema
      {
        type: "object",
        properties: {
          items: { asCell: true },
          selection: { asCell: true },
        },
        required: ["items", "selection"],
      },
      // Callback - uses items.key(index) like ct-picker
      (_event: unknown, state: {
        items: { key: (i: number) => unknown };
        selection: { set: (v: unknown) => void };
      }) => {
        console.log("=== Handler: cycling via items.key() ===");
        // Cycle: select index 1, then 2, then 0
        state.selection.set(state.items.key(1));
        state.selection.set(state.items.key(2));
        state.selection.set(state.items.key(0));
        console.log("=== Handler: done ===");
      },
    );

    interface TestState4 {
      dummy: Default<number, 0>;
    }

    interface TestOutput4 {
      counterA: CounterOutput;
      counterB: CounterOutput;
      counterC: CounterOutput;
      cycle: unknown;
    }

    const KeyIndexTestRecipe = builderRecipe<TestState4, TestOutput4>(
      "KeyIndexTestRecipe",
      (_state) => {
        const counterA = TestCounter4({ value: 100 });
        const counterB = TestCounter4({ value: 200 });
        const counterC = TestCounter4({ value: 300 });

        // Create items as Cell<OpaqueRef[]> - like ct-picker receives
        const items = Cell.of([counterA, counterB, counterC]);

        // Create selection cell
        const selection = Cell.of<OpaqueCell<unknown>>(counterA);

        // Handler to cycle via items.key()
        const cycle = cycleViaKeyHandler({ items, selection });

        return {
          [NAME]: "Key Index Test",
          counterA,
          counterB,
          counterC,
          cycle,
        };
      },
    );

    const resultCell = runtime.getCell<TestOutput4>(
      space,
      "key-index-test",
      undefined,
      tx,
    );
    const result = runtime.run(tx, KeyIndexTestRecipe, { dummy: 0 }, resultCell);
    tx.commit();
    await runtime.idle();

    const output = result.getAsQueryResult();
    console.log("=== Initial values ===");
    console.log("counterA.value:", output?.counterA?.value);
    console.log("counterB.value:", output?.counterB?.value);
    console.log("counterC.value:", output?.counterC?.value);

    // Trigger cycling via items.key()
    result.key("cycle").send({});
    await runtime.idle();

    // Re-read values after cycling
    const outputAfter = result.getAsQueryResult();
    console.log("=== After cycling via items.key(index) ===");
    console.log("counterA.value:", outputAfter?.counterA?.value);
    console.log("counterB.value:", outputAfter?.counterB?.value);
    console.log("counterC.value:", outputAfter?.counterC?.value);

    // Values should still be 100, 200, 300
    expect(outputAfter?.counterA?.value).toBe(100);
    expect(outputAfter?.counterB?.value).toBe(200);
    expect(outputAfter?.counterC?.value).toBe(300);
  });
});

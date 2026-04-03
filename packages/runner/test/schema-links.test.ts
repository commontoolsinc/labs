// Link resolution tests: array element links, cross-space array links,
// and validateAndTransform with redirect links.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCell } from "../src/cell.ts";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { ID, type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { createDataCellURI } from "../src/link-utils.ts";
import { toCell } from "../src/back-to-cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { CellResult } from "../src/query-result-proxy.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const signer2 = await Identity.fromPassphrase("test operator 2");
const space2 = signer2.did();

describe("Schema - Link Resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Array element link resolution", () => {
    it("should resolve array element links to the actual nested documents", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "number" },
              },
              required: ["name", "value"],
            },
          },
        },
        required: ["items"],
      } as const satisfies JSONSchema;

      const listCell = runtime.getCell(
        space,
        "array-link-list",
        schema,
        tx,
      );

      // Create nested documents in the array using [ID] syntax
      listCell.set({
        items: [
          { [ID]: "item-1", name: "Item 1", value: 10 },
          { [ID]: "item-2", name: "Item 2", value: 20 },
          { [ID]: "item-3", name: "Item 3", value: 30 },
        ],
      });

      const itemValue = listCell.key("items").key(0).get();
      const linkedCell = (itemValue as any)[toCell]();

      const itemCell = listCell.key("items").key(0);

      // Direct links from cells should have the full path
      expect(itemCell.getAsNormalizedFullLink().path).toEqual(["items", "0"]);
      expect(linkedCell.getAsNormalizedFullLink().path).toEqual(["items", "0"]);

      // Get the array result
      const result = listCell.get();

      // Both the cell key version and the toCell version of items should have the same path
      // since there is no link
      const itemsCell = (result.items as any)[toCell]();
      expect(listCell.key("items").getAsNormalizedFullLink().path).toEqual([
        "items",
      ]);
      expect(itemsCell.getAsNormalizedFullLink().path).toEqual(["items"]);

      // Convert items back to cells and check their links
      const itemCells = result.items.map((item: any) => item[toCell]());
      const links = itemCells.map((cell) => cell.getAsNormalizedFullLink());

      // Verify the links point to unique documents (empty path)
      expect(links[0].path).toEqual([]);
      expect(links[1].path).toEqual([]);
      expect(links[2].path).toEqual([]);

      // Verify they have different IDs (unique documents)
      expect(links[0].id).not.toBe(links[1].id);
      expect(links[1].id).not.toBe(links[2].id);
      expect(links[0].id).not.toBe(links[2].id);
    });

    it("should create URIs for plain objects not marked asCell", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
        required: ["items"],
      } as const satisfies JSONSchema;

      const listCell = runtime.getCell(
        space,
        "array-plain-items",
        schema,
        tx,
      );

      // Create plain objects (not nested documents)
      listCell.set({
        items: [
          { name: "Item 1" },
          { name: "Item 2" },
          { name: "Item 3" },
        ],
      });

      // Get the array result
      const result = listCell.get();

      // Convert items back to cells and check their links
      const itemCells = result.items.map((item: any) => item[toCell]());
      const links = itemCells.map((cell) => cell.getAsNormalizedFullLink());

      // Plain objects now also get ids assigned
      expect(links[0].id).toMatch(/^of:/);
      expect(links[1].id).toMatch(/^of:/);
      expect(links[2].id).toMatch(/^of:/);
      expect(links[0].path).toEqual([]);
      expect(links[1].path).toEqual([]);
      expect(links[2].path).toEqual([]);

      // Each should have unique data URIs
      expect(links[0].id).not.toBe(links[1].id);
      expect(links[1].id).not.toBe(links[2].id);
    });

    it("should support array splice operations with nested documents", () => {
      const schema = {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                done: { type: "boolean" },
              },
              required: ["title", "done"],
            },
          },
        },
        required: ["todos"],
      } as const satisfies JSONSchema;

      const todoCell = runtime.getCell(
        space,
        "todo-list-splice",
        schema,
        tx,
      );

      // Create todos as nested documents
      todoCell.set({
        todos: [
          { [ID]: "todo-1", title: "Task 1", done: false },
          { [ID]: "todo-2", title: "Task 2", done: true },
          { [ID]: "todo-3", title: "Task 3", done: false },
        ],
      });

      // Get initial state and verify nested documents
      const initialData = todoCell.get();
      const initialCells = initialData.todos.map((item: any) => item[toCell]());
      const initialLinks = initialCells.map((cell) =>
        cell.getAsNormalizedFullLink()
      );

      // All should have empty paths (nested documents)
      expect(initialLinks[0].path).toEqual([]);
      expect(initialLinks[1].path).toEqual([]);
      expect(initialLinks[2].path).toEqual([]);

      // Store the IDs for comparison after splice
      const id1 = initialLinks[0].id;
      const id3 = initialLinks[2].id;

      // Simulate the pattern from todo-list.tsx - using spread to copy array
      const data = [...todoCell.get().todos];
      const idx = data.findIndex((item) => item.title === "Task 2");
      expect(idx).toBe(1);

      data.splice(idx, 1);
      todoCell.set({ todos: data });

      // Verify the item was removed
      const updated = todoCell.get();
      expect(updated.todos).toHaveLength(2);

      // Verify the remaining items still point to their original documents
      const remainingCells = updated.todos.map((item: any) => item[toCell]());
      const remainingLinks = remainingCells.map((cell) =>
        cell.getAsNormalizedFullLink()
      );

      // Should still have empty paths
      expect(remainingLinks[0].path).toEqual([]);
      expect(remainingLinks[1].path).toEqual([]);

      // Should have the same IDs as before (minus the removed one)
      expect(remainingLinks[0].id).toBe(id1);
      expect(remainingLinks[1].id).toBe(id3);
    });

    it("should handle mixed arrays with both nested documents and plain objects", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                value: { type: "string" },
              },
              required: ["type", "value"],
            },
          },
        },
        required: ["items"],
      } as const satisfies JSONSchema;

      const mixedCell = runtime.getCell(
        space,
        "mixed-array",
        schema,
        tx,
      );

      // Mix of nested documents and plain objects
      mixedCell.set({
        items: [
          { [ID]: "nested-1", type: "document", value: "A" },
          { type: "plain", value: "B" }, // Plain object
          { [ID]: "nested-2", type: "document", value: "C" },
          { type: "plain", value: "D" }, // Plain object
        ],
      });

      const result = mixedCell.get();
      const cells = result.items.map((item: any) => item[toCell]());
      const links = cells.map((cell) => cell.getAsNormalizedFullLink());

      // Nested documents have empty paths
      expect(links[0].path).toEqual([]);
      expect(links[2].path).toEqual([]);

      // Plain objects now also have empty paths (data URIs)
      expect(links[1].path).toEqual([]);
      expect(links[3].path).toEqual([]);

      // Nested documents should have unique IDs (of: format)
      expect(links[0].id).not.toBe(links[2].id);
      expect(links[0].id).toMatch(/^of:/);
      expect(links[2].id).toMatch(/^of:/);

      // Plain objects should have gotten IDs as well
      expect(links[1].id).toMatch(/^of:/);
      expect(links[3].id).toMatch(/^of:/);
      expect(links[1].id).not.toBe(links[3].id); // Different data URIs
    });

    it("should preserve nested document references when reordering arrays", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                order: { type: "number" },
              },
              required: ["name", "order"],
            },
          },
        },
        required: ["items"],
      } as const satisfies JSONSchema;

      const listCell = runtime.getCell(
        space,
        "reorder-array-test",
        schema,
        tx,
      );

      // Create array with nested documents
      listCell.set({
        items: [
          { [ID]: "doc-a", name: "A", order: 1 },
          { [ID]: "doc-b", name: "B", order: 2 },
          { [ID]: "doc-c", name: "C", order: 3 },
        ],
      });

      // Get references before reordering
      const beforeReorder = listCell.get();
      const beforeCells = beforeReorder.items.map((item: any) =>
        item[toCell]()
      );
      const beforeLinks = beforeCells.map((cell) =>
        cell.getAsNormalizedFullLink()
      );

      // Verify initial state - all should be nested documents with empty paths
      expect(beforeLinks[0].path).toEqual([]);
      expect(beforeLinks[1].path).toEqual([]);
      expect(beforeLinks[2].path).toEqual([]);

      // Store IDs for comparison
      const idA = beforeLinks[0].id;
      const idB = beforeLinks[1].id;
      const idC = beforeLinks[2].id;

      // Reorder the array - move first item to end
      const items = [...listCell.get().items];
      const [removed] = items.splice(0, 1);
      items.push(removed);
      listCell.set({ items });

      // Get state after reordering
      const afterReorder = listCell.get();
      const afterCells = afterReorder.items.map((item: any) => item[toCell]());
      const afterLinks = afterCells.map((cell) =>
        cell.getAsNormalizedFullLink()
      );

      // Items should still be nested documents with empty paths
      expect(afterLinks[0].path).toEqual([]);
      expect(afterLinks[1].path).toEqual([]);
      expect(afterLinks[2].path).toEqual([]);

      // The IDs should match the reordered pattern (B, C, A)
      expect(afterLinks[0].id).toBe(idB);
      expect(afterLinks[1].id).toBe(idC);
      expect(afterLinks[2].id).toBe(idA);
    });

    it("should handle array element resolution via proxy (TypeScript generics)", () => {
      // This test uses TypeScript generics instead of JSON schema
      // to test the proxy code path
      const listCell = runtime.getCell<{ items: any[] }>(
        space,
        "array-proxy-test",
        undefined,
        tx,
      );

      // Create nested documents in the array
      listCell.set({
        items: [
          { [ID]: "proxy-1", name: "Proxy 1", value: 100 },
          { [ID]: "proxy-2", name: "Proxy 2", value: 200 },
        ],
      });

      // Get the array result
      const result = listCell.get();

      // Convert items back to cells and check their links
      const itemCells = result.items.map((item: any) => item[toCell]());
      const links = itemCells.map((cell) => cell.getAsNormalizedFullLink());

      // Verify the links point to unique documents (empty path)
      expect(links[0].path).toEqual([]);
      expect(links[1].path).toEqual([]);

      // Verify they have different IDs (unique documents)
      expect(links[0].id).not.toBe(links[1].id);

      // Test array operations work correctly
      const data = [...result.items];
      data.splice(0, 1); // Remove first item
      listCell.set({ items: data });

      const updated = listCell.get();
      expect(updated.items).toHaveLength(1);

      // Verify the remaining item still points to its original document
      const remainingCell = updated.items[0][toCell]();
      const remainingLink = remainingCell.getAsNormalizedFullLink();
      expect(remainingLink.path).toEqual([]);
      expect(remainingLink.id).toBe(links[1].id);
    });
  });

  describe("toCell symbol non-enumerable behavior", () => {
    it("should not copy toCell symbol when spreading object", () => {
      const cell = runtime.getCell<{ name: string; value: number }>(
        space,
        "spread-test",
        {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
        },
        tx,
      );

      cell.set({ name: "original", value: 42 });
      const obj = cell.get();

      // Verify the object has toCell
      expect((obj as any)[toCell]).toBeDefined();
      expect(typeof (obj as any)[toCell]).toBe("function");

      // Spread the object
      const spread = { ...obj };

      // The spread object should NOT have toCell
      expect((spread as any)[toCell]).toBeUndefined();

      // The original object should still have toCell
      expect((obj as any)[toCell]).toBeDefined();
    });

    it("should not copy toCell when modifying object with spread", () => {
      const cell = runtime.getCell<{ name: string; value: number }>(
        space,
        "spread-modify-test",
        {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
        },
        tx,
      );

      cell.set({ name: "original", value: 42 });
      const obj = cell.get();

      // Create a modified copy using spread
      const modified = { ...obj, value: 100 };

      // The modified object should not have toCell
      expect((modified as any)[toCell]).toBeUndefined();

      // The original should still have toCell pointing to the correct cell
      const originalCell = (obj as any)[toCell]();
      expect(isCell(originalCell)).toBe(true);
      expect(originalCell.get()).toEqual({ name: "original", value: 42 });
    });

    it("should not enumerate toCell in Object.keys", () => {
      const cell = runtime.getCell<{ name: string; value: number }>(
        space,
        "keys-test",
        {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
        },
        tx,
      );

      cell.set({ name: "test", value: 123 });
      const obj = cell.get();

      // toCell should not appear in Object.keys
      const keys = Object.keys(obj);
      expect(keys).toEqual(["name", "value"]);
      expect(keys).not.toContain(toCell);
    });

    it("should not enumerate toCell in for...in loop", () => {
      const cell = runtime.getCell<{ name: string; value: number }>(
        space,
        "forin-test",
        {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
        },
        tx,
      );

      cell.set({ name: "test", value: 456 });
      const obj = cell.get();

      // Collect keys from for...in
      const keys: string[] = [];
      for (const key in obj) {
        keys.push(key);
      }

      expect(keys).toEqual(["name", "value"]);
      expect(keys).not.toContain(toCell as any);
    });
  });

  describe("Cross-space array link resolution", () => {
    it("should correctly follow cross-space links for arrays with linked elements", () => {
      // This test verifies the fix for a bug where cross-space links weren't
      // correctly followed for arrays when:
      // 1. The initial cell is in space A (an alias to an array in space B)
      // 2. The actual array is in space B
      // 3. Each entry in the array is a link to another cell in space B
      // 4. A schema is applied

      // Create the actual item cells in space B
      const tx2 = runtime.edit();
      const item1 = runtime.getCell<{ name: string; value: number }>(
        space2,
        "cross-space-item-1",
        undefined,
        tx2,
      );
      item1.set({ name: "Item 1", value: 10 });

      const item2 = runtime.getCell<{ name: string; value: number }>(
        space2,
        "cross-space-item-2",
        undefined,
        tx2,
      );
      item2.set({ name: "Item 2", value: 20 });

      // Create the array in space B with links to the items
      const arrayInSpaceB = runtime.getCell<any[]>(
        space2,
        "cross-space-array",
        undefined,
        tx2,
      );
      arrayInSpaceB.setRaw([
        item1.getAsLink(),
        item2.getAsLink(),
      ]);

      tx2.commit();

      // Create an alias in space A that points to the array in space B
      const aliasInSpaceA = runtime.getCell<any>(
        space,
        "cross-space-alias",
        undefined,
        tx,
      );
      aliasInSpaceA.setRaw(arrayInSpaceB.getAsLink());

      // Define the schema
      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
          required: ["name", "value"],
        },
      } as const satisfies JSONSchema;

      // Access through space A with schema - this is where the bug manifested
      const result = aliasInSpaceA.asSchema(schema).get();

      // Verify the data is correctly resolved
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Item 1");
      expect(result[0].value).toBe(10);
      expect(result[1].name).toBe("Item 2");
      expect(result[1].value).toBe(20);

      // Verify the links point to space B (the correct space)
      const cell0 = (result[0] as any)[toCell]();
      const cell1 = (result[1] as any)[toCell]();

      const link0 = cell0.getAsNormalizedFullLink();
      const link1 = cell1.getAsNormalizedFullLink();

      // Both links should point to space B, not space A
      expect(link0.space).toBe(space2);
      expect(link1.space).toBe(space2);

      // They should have empty paths (pointing to actual documents, not array indices)
      expect(link0.path).toEqual([]);
      expect(link1.path).toEqual([]);
    });

    it("should correctly resolve cross-space links for arrays with inline objects", () => {
      // Similar test but with inline objects that get data URIs

      // Create an array in space B with inline objects (no explicit IDs)
      const tx2 = runtime.edit();
      const arrayInSpaceB = runtime.getCell<any[]>(
        space2,
        "cross-space-inline-array",
        undefined,
        tx2,
      );
      arrayInSpaceB.set([
        { name: "Inline 1", value: 100 },
        { name: "Inline 2", value: 200 },
      ]);

      tx2.commit();

      // Create an alias in space A
      const aliasInSpaceA = runtime.getCell<any>(
        space,
        "cross-space-inline-alias",
        undefined,
        tx,
      );
      aliasInSpaceA.setRaw(arrayInSpaceB.getAsLink());

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "number" },
          },
          required: ["name", "value"],
        },
      } as const satisfies JSONSchema;

      // Access through space A with schema
      const result = aliasInSpaceA.asSchema(schema).get();

      // Verify data
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Inline 1");
      expect(result[1].name).toBe("Inline 2");

      // Verify the links point to space B
      const cell0 = (result[0] as any)[toCell]();
      const cell1 = (result[1] as any)[toCell]();

      const link0 = cell0.getAsNormalizedFullLink();
      const link1 = cell1.getAsNormalizedFullLink();

      // Both links should point to space B (the space where the array lives)
      expect(link0.space).toBe(space2);
      expect(link1.space).toBe(space2);
    });
  });

  /**
   * Tests for validateAndTransform behavior with redirect and regular links.
   *
   * Chain structure:
   *   start --redirect--> redir --redirect--> first --regular--> second --regular--> data
   *     ^                                       ^                   ^                   ^
   *     |                                       |                   |                   |
   *   query from here               toCell() returns this    asCell returns this    actual value
   *
   * Current behavior:
   * - All consecutive redirect links are followed until the first non-redirect cell
   * - Without asCell: toCell() returns the first non-redirect cell (first)
   * - With asCell: returns a Cell pointing one step further (second)
   */
  describe("validateAndTransform with redirect links", () => {
    it("without asCell: toCell() returns first non-redirect cell", () => {
      // Chain: start --redirect--> redir --redirect--> first --regular--> second --regular--> data
      //
      // Behavior: All redirect links are followed, toCell() stops at first non-redirect
      // The data is fully resolved to { test: "foo" } but the cell reference stops at `first`

      // data: holds the actual value
      const data = runtime.getCell<{ test: string }>(
        space,
        "redirect-test-data",
        undefined,
        tx,
      );
      data.set({ test: "foo" });

      // second: regular link to data
      const second = runtime.getCell<any>(
        space,
        "redirect-test-second",
        undefined,
        tx,
      );
      second.setRaw(data.getAsLink());

      // first: regular link to second (first non-redirect in chain)
      const first = runtime.getCell<any>(
        space,
        "redirect-test-first",
        undefined,
        tx,
      );
      first.setRaw(second.getAsLink());

      // redir: redirect link to first
      const redir = runtime.getCell<any>(
        space,
        "redirect-test-redir",
        undefined,
        tx,
      );
      redir.setRaw(first.getAsWriteRedirectLink());

      // start: redirect link to redir (entry point for query)
      const start = runtime.getCell<any>(
        space,
        "redirect-test-start",
        undefined,
        tx,
      );
      start.setRaw(redir.getAsWriteRedirectLink());

      const objectSchema = {
        type: "object",
        properties: {
          test: { type: "string" },
        },
      } as const satisfies JSONSchema;

      const result = start.asSchema(objectSchema).get();

      // Data is fully resolved through all links
      expect(result).toEqualIgnoringSymbols({ test: "foo" });

      // toCell() returns the first non-redirect cell (`first`)
      const cellFromResult = (result as any)[toCell]();
      expect(isCell(cellFromResult)).toBe(true);
      const cellFromResultLink = cellFromResult.getAsNormalizedFullLink();
      const firstLink = first.getAsNormalizedFullLink();

      expect(cellFromResultLink.id).toBe(firstLink.id);
      expect(cellFromResultLink.path).toEqual(firstLink.path);
    });

    it("with asCell: returns Cell pointing one step past first non-redirect", () => {
      // With => indicating redirect links and -> indicating regular links:
      // Chain: outer => inner => redir => first -> second -> data
      //
      // Behavior: All redirect links are followed, then one more regular link is followed
      // Result is a Cell pointing to `second` (not `first`, not `data`)

      // data: holds the actual value
      const data = runtime.getCell<{ test: { foo: string } }>(
        space,
        "redirect-test-ascell-data",
        undefined,
        tx,
      );
      data.set({ test: { foo: "bar" } });

      // second: regular link to data
      const second = runtime.getCell<any>(
        space,
        "redirect-test-ascell-second",
        undefined,
        tx,
      );
      second.setRaw(data.getAsLink());

      // first: regular link to second (first non-redirect in chain)
      const first = runtime.getCell<any>(
        space,
        "redirect-test-ascell-first",
        undefined,
        tx,
      );
      first.setRaw(second.getAsLink());

      // redir: redirect link to first
      const redir = runtime.getCell<any>(
        space,
        "redirect-test-ascell-redir",
        undefined,
        tx,
      );
      redir.setRaw(first.getAsWriteRedirectLink());

      // inner: redirect link to redir (entry point for query)
      const inner = runtime.getCell<any>(
        space,
        "redirect-test-ascell-inner",
        undefined,
        tx,
      );
      inner.setRaw(redir.getAsWriteRedirectLink());

      // outer: redirect link to redir (entry point for query)
      const outer = runtime.getCell<any>(
        space,
        "redirect-test-ascell-outer",
        undefined,
        tx,
      );
      outer.setRaw({ inner: inner.getAsWriteRedirectLink() });

      const asObjectSchema = {
        type: "object",
        properties: {
          test: { type: "object", properties: { foo: { type: "string" } } },
        },
      } as const satisfies JSONSchema;

      const asCellSchema = {
        type: "object",
        properties: {
          test: { type: "object", properties: { foo: { type: "string" } } },
        },
        asCell: true,
      } as const satisfies JSONSchema;

      const resultCell = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
        asCell: true,
      }).get();
      expect(isCell(resultCell)).toBe(true);

      const resultInnerCell = outer.asSchema({
        type: "object",
        properties: { inner: asCellSchema },
      }).key("inner").get();
      expect(isCell(resultInnerCell)).toBe(true);

      const resultInnerCell2 = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
      }).key("inner").asSchema(asCellSchema).get();
      expect(isCell(resultInnerCell2)).toBe(true);

      const outerInnerCell = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
      }).key("inner");
      expect(isCell(outerInnerCell)).toBe(true);

      const resultContents = outer.asSchema({
        type: "object",
        properties: { inner: asCellSchema },
      }).get();

      const resultInnerContents = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
      }).key("inner").get();

      // Set these up for easier comparisons
      const dataCellLink = data.getAsNormalizedFullLink();
      const secondCellLink = second.getAsNormalizedFullLink();
      const firstCellLink = first.getAsNormalizedFullLink();
      const outerCellLink = outer.getAsNormalizedFullLink();

      // Result Cell points to `second` (one step past the first non-redirect)
      const resultCellLink = resultCell.getAsNormalizedFullLink();
      const outerLink = outer.getAsNormalizedFullLink();

      expect(resultCellLink.id).toBe(outerCellLink.id);
      // resultContents was returned from outer.get(), so its toCell() returns outer
      const resultContentsToCell = (resultContents as any)[toCell]();
      expect(resultContentsToCell.getAsNormalizedFullLink().id).toBe(
        outerLink.id,
      );

      // Test that we have our object
      expect(resultInnerContents!.test).toEqual({ foo: "bar" });

      // resultInnerContents was returned from outer's inner.get(), and
      // inner->redir->first are all writeRedirect, so its toCell() returns
      // the first cell.
      const resultContentsInnerToCell = (resultInnerContents as any)[toCell]();
      const resultContentsInnerToCellLink = resultContentsInnerToCell
        .getAsNormalizedFullLink();
      expect(resultContentsInnerToCellLink.id).toBe(firstCellLink.id);
      expect(resultContentsInnerToCellLink.path).toEqual([]);

      // inner->redir->first are all writeRedirect, and then first->second is
      // the non-redirect
      const resultInnerCellLink = resultInnerCell!.getAsNormalizedFullLink();
      expect(resultInnerCellLink.id).toBe(secondCellLink.id);
      expect(resultInnerCellLink.path).toEqual([]);

      // really just the same as above, but the asCell comes from parent
      // (our cell object) instead of from the link (the data)
      const resultInnerCell2Link = resultInnerCell2!.getAsNormalizedFullLink();
      expect(resultInnerCell2Link.id).toBe(secondCellLink.id);
      expect(resultInnerCell2Link.path).toEqual([]);

      // outerInnerCell is the outer cell, but with a key of "inner"
      // we shouldn't do any link following here.
      const outerInnerCellLink = outerInnerCell.getAsNormalizedFullLink();
      expect(outerInnerCellLink.id).toBe(outerCellLink.id);
      expect(outerInnerCellLink.path).toEqual(["inner"]);

      // const resultContentsInnerToCell =
      //   (resultInnerContents as CellResult<unknown>)[toCell]();

      // Round trip through the get/toCell chain.
      const innerCellLink2 = (inner.get() as any)[toCell]()
        .getAsNormalizedFullLink();
      expect(innerCellLink2.id).toBe(dataCellLink.id);
      expect(innerCellLink2.path).toEqual([]);
    });

    it("with toCell: returns Cell pointing past redirects if needed for full path", () => {
      // A => B.foo.bar (getAsRedirectLink)
      // B.foo => C.baz (getAsRedirectLink)
      // C -> D (getAsLink)
      // A[toCell] should be D[baz,bar], since B doesn't have bar
      const cellASchema = {
        type: "object",
        properties: { text: { type: "string" } },
      } as const satisfies JSONSchema;
      const cellDSchema = {
        type: "object",
        properties: {
          baz: {
            type: "object",
            properties: {
              bar: cellASchema,
            },
          },
        },
      } as const satisfies JSONSchema;
      const cellBSchema = {
        type: "object",
        properties: {
          foo: cellDSchema.properties.baz,
        },
      } as const satisfies JSONSchema;

      // of:baedreih6urwxjtneq26vglfm3bhtvob3vvtaryaghbmbyrrngame62apjq
      const cellD = runtime.getCell<{ baz: { bar: { text: string } } }>(
        space,
        "redirect-test-ascell-d",
        cellDSchema,
        tx,
      );
      const cellDLink = cellD.getAsNormalizedFullLink();
      cellD.set({ baz: { bar: { text: "dummy" } } });

      // of:baedreian4qt2iajev5hzb33p3obcoz4v237b53mwro4hd2wtfpp54xrn64
      const cellC = runtime.getCell<{ baz: { bar: { text: string } } }>(
        space,
        "redirect-test-ascell-c",
        cellDSchema, // same as cellD
        tx,
      );
      cellC.setRawUntyped(cellD.getAsLink());

      // of:baedreifyl2zipph2s75lxkbi6tttr4euo5bsmt53xwznkoc43tk5jqayse
      const cellB = runtime.getCell<
        { foo: { baz: { bar: { text: string } } } }
      >(
        space,
        "redirect-test-ascell-b",
        cellBSchema,
        tx,
      );
      // Set a valid starter value
      cellB.set({ foo: { baz: { bar: { text: "initial" } } } });
      // Then set up the link
      cellB.key("foo").setRawUntyped(
        cellC.key("baz").getAsWriteRedirectLink(),
      );

      // of:baedreib4ycxtyccm5w2jmi2l6kx6hehjsnkwq6tu4end2kyaz7mzmmhtru
      const cellA = runtime.getCell<{ text: string }>(
        space,
        "redirect-test-ascell-a",
        cellASchema,
        tx,
      );
      // Then set up the link
      cellA.setRawUntyped(
        cellB.key("foo").key("bar").getAsWriteRedirectLink(),
      );

      const cellAContents = cellA.get();
      const cellALink = (cellAContents as CellResult<any>)[toCell]()
        .getAsNormalizedFullLink();
      expect(cellALink.id).toBe(cellDLink.id);
      expect(cellALink.path).toEqual(["baz", "bar"]);
    });

    it("with toCell: returns Cell pointing to the last redirect with proper path (no schema)", () => {
      // A.foo => B.label (getAsRedirectLink)
      // B.label.bar -> C.value (getAsLink)
      // C.value -> D.value (getAsLink)
      // D.value = {baz: {text: "dummy"}
      // A.foo[toCell] should return B[label] (matches redirDoc)
      // A.foo.bar[toCell] should return B[label.bar] (carries the remaining "bar" down to B),
      // but our implementation without a schema returns D[value]
      // A.foo.bar.baz[toCell] should return D[value.baz], since this only exists in D and not C or B.

      const cellD = runtime.getCell<{ value: { baz: { text: string } } }>(
        space,
        "redirect-test-ascell-d",
        undefined,
        tx,
      );
      const cellDLink = cellD.getAsNormalizedFullLink();
      cellD.set({ value: { baz: { text: "dummy" } } });

      const cellC = runtime.getCell<{ value: { baz: { text: string } } }>(
        space,
        "redirect-test-ascell-c",
        undefined,
        tx,
      );
      cellC.set({ value: { baz: { text: "dummy" } } });
      cellC.key("value").setRawUntyped(cellD.key("value").getAsLink());

      const cellB = runtime.getCell<
        { label: { bar: { baz: { text: string } } } }
      >(
        space,
        "redirect-test-ascell-b",
        undefined,
        tx,
      );
      const cellBLink = cellB.getAsNormalizedFullLink();
      // Set a valid starter value
      cellB.set({ label: { bar: { baz: { text: "initial" } } } });
      // Then set up the link
      cellB.key("label").key("bar").setRawUntyped(
        cellC.key("value").getAsLink(),
      );

      const cellA = runtime.getCell<
        { foo: { bar: { baz: { text: string } } } }
      >(
        space,
        "redirect-test-ascell-a",
        undefined,
        tx,
      );
      // Set a valid starter value
      cellA.set({ foo: { bar: { baz: { text: "initial" } } } });
      // Then set up the link
      cellA.key("foo").setRawUntyped(
        cellB.key("label").getAsWriteRedirectLink(),
      );

      // A.foo[toCell] should be B[label] (matches redirDoc)
      // A.foo.bar[toCell] should be B[label.bar] (carries the remaining "bar" down to B)
      // A.foo.bar.baz[toCell] should be C[value.baz]
      const cellAContents = cellA.get();
      const cellAFooLink = (cellAContents.foo as CellResult<any>)[toCell]()
        .getAsNormalizedFullLink();
      expect(cellAFooLink.id).toBe(cellBLink.id);
      expect(cellAFooLink.path).toEqual(["label"]);

      const cellAFooBarLink = (cellAContents.foo.bar as CellResult<any>)
        [toCell]()
        .getAsNormalizedFullLink();

      expect(cellAContents.foo.bar).toEqualIgnoringSymbols({
        baz: { text: "dummy" },
      });

      // TODO(@ubik2): need to figure out why this is "wrong" in the non-schema
      // case, but for now, we preserve the existing behavior.
      expect(cellAFooBarLink.id).toBe(cellDLink.id);
      expect(cellAFooBarLink.path).toEqual(["value"]);
      //expect(cellAFooBarLink.id).toBe(cellBLink.id);
      //expect(cellAFooBarLink.path).toEqual(["label", "bar"]);

      expect(cellB.key("label").get()).toEqualIgnoringSymbols({
        bar: { baz: { text: "dummy" } },
      });
      expect(cellAContents.foo.bar.baz).toEqualIgnoringSymbols({
        text: "dummy",
      });

      const cellAFooBarBazLink = (cellAContents.foo.bar.baz as CellResult<any>)
        [toCell]()
        .getAsNormalizedFullLink();
      expect(cellAFooBarBazLink.id).toBe(cellDLink.id);
      expect(cellAFooBarBazLink.path).toEqual(["value", "baz"]);
    });

    it("with toCell: returns Cell pointing to the last redirect with proper path (with schema)", () => {
      // A.foo => B.label (getAsRedirectLink)
      // B.label.bar -> C.value (getAsLink)
      // C.value -> D.value (getAsLink)
      // D.value = {baz: {text: "dummy"}
      // A.foo[toCell] should return B[label] (matches redirDoc)
      // A.foo.bar[toCell] should return B[label.bar] (carries the remaining "bar" down to B),
      // though our implementation without a schema returns D[value]
      // A.foo.bar.baz[toCell] should return D[value.baz], since this only exists in D and not C or B.

      const cellDSchema = {
        type: "object",
        properties: {
          value: {
            type: "object",
            properties: {
              baz: {
                type: "object",
                properties: { text: { type: "string" } },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const cellBSchema = {
        type: "object",
        properties: {
          label: {
            type: "object",
            properties: {
              bar: cellDSchema.properties.value,
            },
          },
        },
      } as const satisfies JSONSchema;
      const cellASchema = {
        type: "object",
        properties: {
          foo: cellBSchema.properties.label,
        },
      } as const satisfies JSONSchema;

      // of:baedreih6urwxjtneq26vglfm3bhtvob3vvtaryaghbmbyrrngame62apjq
      const cellD = runtime.getCell<{ value: { baz: { text: string } } }>(
        space,
        "redirect-test-ascell-d",
        cellDSchema,
        tx,
      );
      const cellDLink = cellD.getAsNormalizedFullLink();
      cellD.set({ value: { baz: { text: "dummy" } } });

      // of:baedreian4qt2iajev5hzb33p3obcoz4v237b53mwro4hd2wtfpp54xrn64
      const cellC = runtime.getCell<{ value: { baz: { text: string } } }>(
        space,
        "redirect-test-ascell-c",
        cellDSchema, // same as cellD
        tx,
      );
      cellC.set({ value: { baz: { text: "dummy" } } });
      cellC.key("value").setRawUntyped(cellD.key("value").getAsLink());

      // of:baedreifyl2zipph2s75lxkbi6tttr4euo5bsmt53xwznkoc43tk5jqayse
      const cellB = runtime.getCell<
        { label: { bar: { baz: { text: string } } } }
      >(
        space,
        "redirect-test-ascell-b",
        cellBSchema,
        tx,
      );
      const cellBLink = cellB.getAsNormalizedFullLink();
      // Set a valid starter value
      cellB.set({ label: { bar: { baz: { text: "initial" } } } });
      // Then set up the link
      cellB.key("label").key("bar").setRawUntyped(
        cellC.key("value").getAsLink(),
      );

      // of:baedreib4ycxtyccm5w2jmi2l6kx6hehjsnkwq6tu4end2kyaz7mzmmhtru
      const cellA = runtime.getCell<
        { foo: { bar: { baz: { text: string } } } }
      >(
        space,
        "redirect-test-ascell-a",
        cellASchema,
        tx,
      );
      // Set a valid starter value
      cellA.set({ foo: { bar: { baz: { text: "initial" } } } });
      // Then set up the link
      cellA.key("foo").setRawUntyped(
        cellB.key("label").getAsWriteRedirectLink(),
      );

      // A.foo[toCell] should be B[label] (matches redirDoc)
      // A.foo.bar[toCell] should be B[label.bar] (carries the remaining "bar" down to B)
      // A.foo.bar.baz[toCell] should be C[value.baz]
      const cellAContents = cellA.get();
      const cellAFooLink = (cellAContents.foo as CellResult<any>)[toCell]()
        .getAsNormalizedFullLink();
      expect(cellAFooLink.id).toBe(cellBLink.id);
      expect(cellAFooLink.path).toEqual(["label"]);

      const cellAFooBarLink = (cellAContents.foo.bar as CellResult<any>)
        [toCell]()
        .getAsNormalizedFullLink();

      expect(cellAContents.foo.bar).toEqualIgnoringSymbols({
        baz: { text: "dummy" },
      });

      expect(cellAFooBarLink.id).toBe(cellBLink.id);
      expect(cellAFooBarLink.path).toEqual(["label", "bar"]);

      expect(cellB.key("label").get()).toEqualIgnoringSymbols({
        bar: { baz: { text: "dummy" } },
      });
      expect(cellAContents.foo.bar.baz).toEqualIgnoringSymbols({
        text: "dummy",
      });

      const cellAFooBarBazLink = (cellAContents.foo.bar.baz as CellResult<any>)
        [toCell]()
        .getAsNormalizedFullLink();
      expect(cellAFooBarBazLink.id).toBe(cellDLink.id);
      expect(cellAFooBarBazLink.path).toEqual(["value", "baz"]);
    });

    it("with toCell: returns Cell pointing to the last redirect with proper path (multiple redirects)", () => {
      // A => B.foo.bar (getAsRedirectLink)
      // B.foo => C.baz (getAsRedirectLink)
      // C -> D (getAsLink)
      // A[toCell] should be D[baz,bar] because we didn't follow a non-redirect
      // link while at the end of the path.
      const cellASchema = {
        type: "object",
        properties: { text: { type: "string" } },
      } as const satisfies JSONSchema;
      const cellDSchema = {
        type: "object",
        properties: {
          baz: {
            type: "object",
            properties: {
              bar: cellASchema,
            },
          },
        },
      } as const satisfies JSONSchema;
      const cellBSchema = {
        type: "object",
        properties: {
          foo: cellDSchema.properties.baz,
        },
      } as const satisfies JSONSchema;

      // of:baedreih6urwxjtneq26vglfm3bhtvob3vvtaryaghbmbyrrngame62apjq
      const cellD = runtime.getCell<{ baz: { bar: { text: string } } }>(
        space,
        "redirect-test-ascell-d",
        cellDSchema,
        tx,
      );
      const cellDLink = cellD.getAsNormalizedFullLink();
      cellD.set({ baz: { bar: { text: "dummy" } } });

      // of:baedreian4qt2iajev5hzb33p3obcoz4v237b53mwro4hd2wtfpp54xrn64
      const cellC = runtime.getCell<{ baz: { bar: { text: string } } }>(
        space,
        "redirect-test-ascell-c",
        cellDSchema, // same as cellD
        tx,
      );
      //const cellCLink = cellC.getAsNormalizedFullLink();
      cellC.setRawUntyped(cellD.getAsLink());

      // of:baedreifyl2zipph2s75lxkbi6tttr4euo5bsmt53xwznkoc43tk5jqayse
      const cellB = runtime.getCell<
        { foo: { baz: { bar: { text: string } } } }
      >(
        space,
        "redirect-test-ascell-b",
        cellBSchema,
        tx,
      );
      // Set a valid starter value
      cellB.set({ foo: { baz: { bar: { text: "initial" } } } });
      // Then set up the link
      cellB.key("foo").setRawUntyped(
        cellC.key("baz").getAsWriteRedirectLink(),
      );

      // of:baedreib4ycxtyccm5w2jmi2l6kx6hehjsnkwq6tu4end2kyaz7mzmmhtru
      const cellA = runtime.getCell<{ text: string }>(
        space,
        "redirect-test-ascell-a",
        cellASchema,
        tx,
      );
      // Then set up the link
      cellA.setRawUntyped(
        cellB.key("foo").key("bar").getAsWriteRedirectLink(),
      );

      const cellAContents = cellA.get();
      const cellALink = (cellAContents as CellResult<any>)[toCell]()
        .getAsNormalizedFullLink();
      expect(cellALink.id).toBe(cellDLink.id);
      expect(cellALink.path).toEqual(["baz", "bar"]);
    });

    it("with data cell: validates contents", async () => {
      const cellASchema = {
        type: "object",
        properties: { system: { type: "string" } },
      } as const satisfies JSONSchema;
      const cellCSchema = {
        type: "object",
        properties: {
          internal: {
            type: "object",
            properties: { "__#1": { type: "string" } },
          },
        },
      } as const satisfies JSONSchema;
      const cellBSchema = {
        type: "object",
        properties: {
          argument: {
            type: "object",
            properties: { system: { type: "string" } },
          },
        },
      } as const satisfies JSONSchema;

      // of:baedreian4qt2iajev5hzb33p3obcoz4v237b53mwro4hd2wtfpp54xrn64
      const cellC = runtime.getCell<{ internal: { "__#1": string } }>(
        space,
        "redirect-test-ascell-c",
        cellCSchema,
        tx,
      );
      const cellCLink = cellC.getAsNormalizedFullLink();
      cellC.set({ internal: { "__#1": "You are a polite..." } });

      // of:baedreifyl2zipph2s75lxkbi6tttr4euo5bsmt53xwznkoc43tk5jqayse
      const cellB = runtime.getCell<{ argument: { system: string } }>(
        space,
        "redirect-test-ascell-b",
        cellBSchema,
        tx,
      );
      const cellBLink = cellB.getAsNormalizedFullLink();
      // cellB's argument.system points to cellC's internal.__#1
      cellB.setRawUntyped({
        "argument": {
          "system": {
            "$alias": {
              "path": ["internal", "__#1"],
              "cell": { "/": cellCLink.id.replace(/^of:/, "") },
            },
          },
        },
      } as FabricValue);

      // data cell's system points to cellB's argument.system
      const dataCellURI = createDataCellURI({
        "system": {
          "$alias": {
            "path": [
              "argument",
              "system",
            ],
            "schema": {
              "type": "string",
              "$defs": {}, // the real case has a bunch here, but it doesn't matter
            },
            "cell": {
              "/": cellBLink.id.replace(/^of:/, ""),
            },
          },
        },
      });
      const cellA = runtime.getCellFromLink(
        {
          id: dataCellURI,
          path: [],
          space,
          type: "application/json",
        },
        cellASchema,
      );

      await tx.commit();
      tx = runtime.edit();

      const cellAContents = cellA.asSchema({
        "type": "object",
        "properties": { "system": { "type": "string", "asOpaque": true } },
        "required": ["system"],
      }).get();
      expect(cellAContents).toEqual({ system: "You are a polite..." });
    });

    it("with asCell object and type unknown: returns Cell pointing one step past first non-redirect", () => {
      // This is basically the same as the other test, but it checks with type
      // unknown to ensure we still follow the same rules.

      // With => indicating redirect links and -> indicating regular links:
      // Chain: outer => inner => redir => first -> second -> data
      //
      // Behavior: All redirect links are followed, then one more regular link is followed
      // Result is a Cell pointing to `second` (not `first`, not `data`)

      // data: holds the actual value
      const data = runtime.getCell<{ test: { foo: string } }>(
        space,
        "redirect-test-ascell-data",
        undefined,
        tx,
      );
      data.set({ test: { foo: "bar" } });

      // second: regular link to data
      const second = runtime.getCell<any>(
        space,
        "redirect-test-ascell-second",
        undefined,
        tx,
      );
      second.setRaw(data.getAsLink());

      // first: regular link to second (first non-redirect in chain)
      const first = runtime.getCell<any>(
        space,
        "redirect-test-ascell-first",
        undefined,
        tx,
      );
      first.setRaw(second.getAsLink());

      // redir: redirect link to first
      const redir = runtime.getCell<any>(
        space,
        "redirect-test-ascell-redir",
        undefined,
        tx,
      );
      redir.setRaw(first.getAsWriteRedirectLink());

      // inner: redirect link to redir (entry point for query)
      const inner = runtime.getCell<any>(
        space,
        "redirect-test-ascell-inner",
        undefined,
        tx,
      );
      inner.setRaw(redir.getAsWriteRedirectLink());

      // outer: redirect link to redir (entry point for query)
      const outer = runtime.getCell<any>(
        space,
        "redirect-test-ascell-outer",
        undefined,
        tx,
      );
      outer.setRaw({ inner: inner.getAsWriteRedirectLink() });

      const asObjectSchema = {
        type: "object",
        properties: {
          test: { type: "unknown" },
        },
      } as const satisfies JSONSchema;

      const asCellSchema = {
        type: "unknown",
        asCell: true,
      } as const satisfies JSONSchema;

      const resultCell = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
        asCell: true,
      }).get();
      expect(isCell(resultCell)).toBe(true);

      const resultInnerCell = outer.asSchema({
        type: "object",
        properties: { inner: asCellSchema },
      }).key("inner").get();
      expect(isCell(resultInnerCell)).toBe(true);

      const resultInnerCell2 = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
      }).key("inner").asSchema(asCellSchema).get();
      expect(isCell(resultInnerCell2)).toBe(true);

      const outerInnerCell = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
      }).key("inner");
      expect(isCell(outerInnerCell)).toBe(true);

      const resultContents = outer.asSchema({
        type: "object",
        properties: { inner: asCellSchema },
      }).get();

      const resultInnerContents = outer.asSchema({
        type: "object",
        properties: { inner: asObjectSchema },
      }).key("inner").get();

      // Set these up for easier comparisons
      const dataCellLink = data.getAsNormalizedFullLink();
      const secondCellLink = second.getAsNormalizedFullLink();
      const firstCellLink = first.getAsNormalizedFullLink();
      const outerCellLink = outer.getAsNormalizedFullLink();

      // Result Cell points to `second` (one step past the first non-redirect)
      const resultCellLink = resultCell.getAsNormalizedFullLink();
      const outerLink = outer.getAsNormalizedFullLink();

      expect(resultCellLink.id).toBe(outerCellLink.id);
      // resultContents was returned from outer.get(), so its toCell() returns outer
      const resultContentsToCell = (resultContents as any)[toCell]();
      expect(resultContentsToCell.getAsNormalizedFullLink().id).toBe(
        outerLink.id,
      );

      const resultInnerContentsCell = resultContents.inner!;
      const resultInnerContentsCellLink = resultInnerContentsCell
        .getAsNormalizedFullLink();
      expect(resultInnerContentsCellLink.id).toBe(secondCellLink.id);
      expect(resultInnerContentsCellLink.path).toEqual([]);

      // Test that unknown type from object turns into undefined
      expect(resultInnerContents!.test).toBeUndefined();

      // resultInnerContents was returned from outer's inner.get(), and
      // inner->redir->first are all writeRedirect, so its toCell() returns
      // the first cell.
      const resultContentsInnerToCell = (resultInnerContents as any)[toCell]();
      const resultContentsInnerToCellLink = resultContentsInnerToCell
        .getAsNormalizedFullLink();
      expect(resultContentsInnerToCellLink.id).toBe(firstCellLink.id);
      expect(resultContentsInnerToCellLink.path).toEqual([]);

      // inner->redir->first are all writeRedirect, and then first->second is
      // the non-redirect
      const resultInnerCellLink = resultInnerCell!.getAsNormalizedFullLink();
      expect(resultInnerCellLink.id).toBe(secondCellLink.id);
      expect(resultInnerCellLink.path).toEqual([]);

      // really just the same as above, but the asCell comes from parent
      // (our cell object) instead of from the link (the data)
      const resultInnerCell2Link = resultInnerCell2!.getAsNormalizedFullLink();
      expect(resultInnerCell2Link.id).toBe(secondCellLink.id);
      expect(resultInnerCell2Link.path).toEqual([]);

      // outerInnerCell is the outer cell, but with a key of "inner"
      // we shouldn't do any link following here.
      const outerInnerCellLink = outerInnerCell.getAsNormalizedFullLink();
      expect(outerInnerCellLink.id).toBe(outerCellLink.id);
      expect(outerInnerCellLink.path).toEqual(["inner"]);

      // const resultContentsInnerToCell =
      //   (resultInnerContents as CellResult<unknown>)[toCell]();

      // Round trip through the get/toCell chain.
      const innerCellLink2 = (inner.get() as any)[toCell]()
        .getAsNormalizedFullLink();
      expect(innerCellLink2.id).toBe(dataCellLink.id);
      expect(innerCellLink2.path).toEqual([]);
    });

    it("with asCell array with type unknown: returns Cell pointing two steps past first non-redirect", () => {
      // With => indicating redirect links and -> indicating regular links:
      // Chain: outer => inner => redir => first -> second -> data
      //
      // Behavior: All redirect links are followed, then one more regular link is followed
      // Result is a Cell pointing to `second` (not `first`, not `data`)

      // data: holds the actual value
      const data = runtime.getCell<{ test: { foo: string } }>(
        space,
        "redirect-test-ascell-data",
        undefined,
        tx,
      );
      data.set({ test: { foo: "bar" } });

      // second: regular link to data
      const second = runtime.getCell<any>(
        space,
        "redirect-test-ascell-second", // #vlqu
        undefined,
        tx,
      );
      second.setRaw(data.getAsLink());

      // first: regular link to second (first non-redirect in chain)
      const first = runtime.getCell<any>(
        space,
        "redirect-test-ascell-first", // #y2ga
        undefined,
        tx,
      );
      first.setRaw(second.getAsLink());

      // redir: redirect link to first
      const redir = runtime.getCell<any>(
        space,
        "redirect-test-ascell-redir", // #nz6y
        undefined,
        tx,
      );
      redir.setRaw(first.getAsWriteRedirectLink());

      // inner: redirect link to redir (entry point for query)
      const inner = runtime.getCell<any>(
        space,
        "redirect-test-ascell-inner", // #hj3u
        undefined,
        tx,
      );
      inner.setRaw(redir.getAsWriteRedirectLink());

      // outer: redirect link to redir (entry point for query)
      const outer = runtime.getCell<any>(
        space,
        "redirect-test-ascell-outer", // #4xxy
        undefined,
        tx,
      );
      outer.setRaw([inner.getAsWriteRedirectLink()]);

      const asObjectSchema = {
        type: "object",
        properties: {
          test: { type: "unknown" },
        },
      } as const satisfies JSONSchema;

      const asCellSchema = {
        type: "unknown",
        asCell: true,
      } as const satisfies JSONSchema;

      const resultCell = outer.asSchema({
        type: "array",
        items: asObjectSchema,
        asCell: true,
      }).get();
      expect(isCell(resultCell)).toBe(true);

      const resultItem0Cell = outer.asSchema({
        type: "array",
        items: asCellSchema,
      }).key("0").get();
      expect(isCell(resultItem0Cell)).toBe(true);

      const resultItem0Cell2 = outer.asSchema({
        type: "array",
        items: asObjectSchema,
      }).key("0").asSchema(asCellSchema).get();
      expect(isCell(resultItem0Cell2)).toBe(true);

      const outerItem0Cell = outer.asSchema({
        type: "array",
        items: asObjectSchema,
      }).key("0");
      expect(isCell(outerItem0Cell)).toBe(true);

      const resultContents = outer.asSchema({
        type: "array",
        items: asCellSchema,
      }).get();

      const resultItem0Contents = outer.asSchema({
        type: "array",
        items: asObjectSchema,
      }).key("0").get();

      // Set these up for easier comparisons
      const dataCellLink = data.getAsNormalizedFullLink();
      const secondCellLink = second.getAsNormalizedFullLink();
      const firstCellLink = first.getAsNormalizedFullLink();
      const outerCellLink = outer.getAsNormalizedFullLink();

      // Result Cell points to `second` (one step past the first non-redirect)
      const resultCellLink = resultCell.getAsNormalizedFullLink();
      const outerLink = outer.getAsNormalizedFullLink();

      expect(resultCellLink.id).toBe(outerCellLink.id);
      // resultContents was returned from outer.get(), so its toCell() returns outer
      const resultContentsToCell = (resultContents as any)[toCell]();
      expect(resultContentsToCell.getAsNormalizedFullLink().id).toBe(
        outerLink.id,
      );

      const resultItem0ContentsCell = resultContents[0];
      const resultItem0ContentsCellLink = resultItem0ContentsCell
        .getAsNormalizedFullLink();
      expect(resultItem0ContentsCellLink.id).toBe(dataCellLink.id);
      expect(resultItem0ContentsCellLink.path).toEqual([]);

      // resultInnerContents was returned from outer's inner.get(), and
      // inner->redir->first are all writeRedirect, so its toCell() returns
      // the first cell.
      const resultContentsItem0ToCell = (resultItem0Contents as any)[toCell]();
      const resultContentsItem0ToCellLink = resultContentsItem0ToCell
        .getAsNormalizedFullLink();
      expect(resultContentsItem0ToCellLink.id).toBe(firstCellLink.id);
      expect(resultContentsItem0ToCellLink.path).toEqual([]);

      // inner->redir->first are all writeRedirect, and then first->second is
      // the non-redirect
      const resultItem0CellLink = resultItem0Cell!.getAsNormalizedFullLink();
      expect(resultItem0CellLink.id).toBe(secondCellLink.id);
      expect(resultItem0CellLink.path).toEqual([]);

      // really just the same as above, but the asCell comes from parent
      // (our cell object) instead of from the link (the data)
      const resultItem0Cell2Link = resultItem0Cell2!.getAsNormalizedFullLink();
      expect(resultItem0Cell2Link.id).toBe(secondCellLink.id);
      expect(resultItem0Cell2Link.path).toEqual([]);

      // outerInnerCell is the outer cell, but with a key of "inner"
      // we shouldn't do any link following here.
      const outerItem0CellLink = outerItem0Cell.getAsNormalizedFullLink();
      expect(outerItem0CellLink.id).toBe(outerCellLink.id);
      expect(outerItem0CellLink.path).toEqual(["0"]);

      // const resultContentsInnerToCell =
      //   (resultInnerContents as CellResult<unknown>)[toCell]();

      // Round trip through the get/toCell chain.
      const item0CellLink2 = (inner.get() as any)[toCell]()
        .getAsNormalizedFullLink();
      expect(item0CellLink2.id).toBe(dataCellLink.id);
      expect(item0CellLink2.path).toEqual([]);
    });
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ID, ID_FIELD } from "../src/builder/types.ts";
import {
  addCommonIDfromObjectID,
  applyChangeSet,
  diffAndUpdate,
  normalizeAndDiff,
  setNestedValue,
} from "../src/data-updating.ts";
import { Runtime } from "../src/runtime.ts";
import {
  isAnyCellLink,
  isCellLink,
  isLegacyCellLink,
} from "../src/link-utils.ts";
import type { LegacyCellLink } from "../src/sigil-types.ts";
import { arrayEqual } from "../src/path-utils.ts";
import { type ReactivityLog } from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { expectCellLinksEqual } from "./test-helpers.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("data-updating", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("setNestedValue", () => {
    it("should set a value at a path", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should set a value at a path 1",
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const success = setNestedValue(testCell.getDoc(), ["b", "c"], 3);
      expect(success).toBe(true);
      expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
    });

    it("should delete no longer used fields when setting a nested value", () => {
      const testCell = runtime.getCell<
        { a: number; b: { c: number; d?: number } }
      >(
        space,
        "should delete no longer used fields 1",
      );
      testCell.set({ a: 1, b: { c: 2, d: 3 } });
      const success = setNestedValue(testCell.getDoc(), ["b"], { c: 4 });
      expect(success).toBe(true);
      expect(testCell.get()).toEqual({ a: 1, b: { c: 4 } });
    });

    it("should log no changes when setting a nested value that is already set", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should log no changes 1",
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const log: ReactivityLog = { reads: [], writes: [] };
      const success = setNestedValue(testCell.getDoc(), [], {
        a: 1,
        b: { c: 2 },
      }, log);
      expect(success).toBe(true); // No changes is still a success
      expect(testCell.get()).toEqual({ a: 1, b: { c: 2 } });
      expect(log.writes).toEqual([]);
    });

    it("should log minimal changes when setting a nested value", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should log minimal changes 1",
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const log: ReactivityLog = { reads: [], writes: [] };
      const success = setNestedValue(testCell.getDoc(), [], {
        a: 1,
        b: { c: 3 },
      }, log);
      expect(success).toBe(true);
      expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
      expect(log.writes.length).toEqual(1);
      expect(log.writes[0].path).toEqual(["b", "c"]);
    });

    it("should fail when setting a nested value on a frozen cell", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should fail when setting a nested value on a frozen cell 1",
      );
      testCell.set({ a: 1, b: { c: 2 } });
      testCell.getDoc().freeze("test");
      const log: ReactivityLog = { reads: [], writes: [] };
      const success = setNestedValue(testCell.getDoc(), [], {
        a: 1,
        b: { c: 3 },
      }, log);
      expect(success).toBe(false);
    });

    it("should correctly update with shorter arrays", () => {
      const testCell = runtime.getCell<{ a: number[] }>(
        space,
        "should correctly update with shorter arrays 1",
      );
      testCell.set({ a: [1, 2, 3] });
      const success = setNestedValue(testCell.getDoc(), ["a"], [1, 2]);
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2] });
    });

    it("should correctly update with a longer arrays", () => {
      const testCell = runtime.getCell<{ a: number[] }>(
        space,
        "should correctly update with a longer arrays 1",
      );
      testCell.set({ a: [1, 2, 3] });
      const success = setNestedValue(testCell.getDoc(), ["a"], [1, 2, 3, 4]);
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2, 3, 4] });
    });

    it("should overwrite an object with an array", () => {
      const testCell = runtime.getCell<{ a: any }>(
        space,
        "should overwrite an object with an array 1",
      );
      testCell.set({ a: { b: 1 } });
      const success = setNestedValue(testCell.getDoc(), ["a"], [1, 2, 3]);
      expect(success).toBeTruthy();
      expect(testCell.get()).toHaveProperty("a");
      expect(testCell.get().a).toHaveLength(3);
      expect(testCell.getAsQueryResult().a).toEqual([1, 2, 3]);
    });
  });

  describe("normalizeAndDiff", () => {
    it("should detect simple value changes", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "normalizeAndDiff simple value changes",
      );
      testCell.set({ value: 42 });
      const current = testCell.key("value").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, 100);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toBe(100);
    });

    it("should detect object property changes", () => {
      const testCell = runtime.getCell<{ user: { name: string; age: number } }>(
        space,
        "normalizeAndDiff object property changes",
      );
      testCell.set({ user: { name: "John", age: 30 } });
      const current = testCell.key("user").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, { name: "Jane", age: 30 });

      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("user").key("name").getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe("Jane");
    });

    it("should detect added object properties", () => {
      const testCell = runtime.getCell<
        { user: { name: string; age?: number } }
      >(
        space,
        "normalizeAndDiff added object properties",
      );
      testCell.set({ user: { name: "John" } });
      const current = testCell.key("user").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, { name: "John", age: 30 });

      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("user").key("age").getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe(30);
    });

    it("should detect removed object properties", () => {
      const testCell = runtime.getCell<{ user: { name: string; age: number } }>(
        space,
        "normalizeAndDiff removed object properties",
      );
      testCell.set({ user: { name: "John", age: 30 } });
      const current = testCell.key("user").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, { name: "John" });

      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("user").key("age").getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe(undefined);
    });

    it("should handle array length changes", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array length changes",
      );
      testCell.set({ items: [1, 2, 3] });
      const current = testCell.key("items").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, [1, 2]);

      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("items").key("length").getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe(2);
    });

    it("should handle array element changes", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array element changes",
      );
      testCell.set({ items: [1, 2, 3] });
      const current = testCell.key("items").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, [1, 5, 3]);

      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("items").key(1).getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe(5);
    });

    it("should follow aliases", () => {
      const testCell = runtime.getCell<{
        value: number;
        alias: any;
      }>(
        space,
        "normalizeAndDiff follow aliases",
      );
      testCell.setRaw({
        value: 42,
        alias: { $alias: { path: ["value"] } },
      });
      const current = testCell.key("alias").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("value").getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe(100);
    });

    it("should update aliases", () => {
      const testCell = runtime.getCell<{
        value: number;
        value2: number;
        alias: any;
      }>(
        space,
        "normalizeAndDiff update aliases",
      );
      testCell.setRaw({
        value: 42,
        value2: 200,
        alias: { $alias: { path: ["value"] } },
      });
      const current = testCell.key("alias").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("value").getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe(100);

      applyChangeSet(changes);

      const changes2 = normalizeAndDiff(current, {
        $alias: { path: ["value2"] },
      });

      applyChangeSet(changes2);

      expect(changes2.length).toBe(1);
      expectCellLinksEqual(changes2[0].location).toEqual(
        testCell.key("alias").getAsLegacyCellLink(),
      );
      expect(changes2[0].value).toEqual({ $alias: { path: ["value2"] } });

      const changes3 = normalizeAndDiff(current, 300);

      expect(changes3.length).toBe(1);
      expectCellLinksEqual(changes3[0].location).toEqual(
        testCell.key("value2").getAsLegacyCellLink(),
      );
      expect(changes3[0].value).toBe(300);
    });

    it("should handle nested changes", () => {
      const testCell = runtime.getCell<{
        user: {
          profile: {
            details: {
              address: {
                city: string;
                zipcode: number;
              };
            };
          };
        };
      }>(
        space,
        "normalizeAndDiff nested changes",
      );
      testCell.set({
        user: {
          profile: {
            details: {
              address: {
                city: "New York",
                zipcode: 10001,
              },
            },
          },
        },
      });
      const current = testCell.key("user").key("profile").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, {
        details: {
          address: {
            city: "Boston",
            zipcode: 10001,
          },
        },
      });

      expect(changes.length).toBe(1);
      expectCellLinksEqual(changes[0].location).toEqual(
        testCell.key("user").key("profile").key("details").key("address").key(
          "city",
        ).getAsLegacyCellLink(),
      );
      expect(changes[0].value).toBe("Boston");
    });

    it("should handle ID-based entity objects", () => {
      const testCell = runtime.getCell<{ items: any[] }>(
        space,
        "should handle ID-based entity objects",
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").key(0).getAsLegacyCellLink();

      const newValue = { [ID]: "item1", name: "First Item" };
      const changes = normalizeAndDiff(
        current,
        newValue,
        undefined,
        "should handle ID-based entity objects",
      );

      // Should create an entity and return changes to that entity
      expect(changes.length).toBe(3);
      expect(changes[0].location.cell.asCell().equals(testCell)).toBe(true);
      expect(changes[0].location.path).toEqual(["items", 0]);
      expect(changes[1].location.cell).not.toBe(changes[0].location.cell);
      expect(changes[1].location.path).toEqual([]);
      expect(changes[2].location.cell).toBe(changes[1].location.cell);
      expect(changes[2].location.path).toEqual(["name"]);
    });

    it("should update the same document with ID-based entity objects", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should update the same document with ID-based entity objects",
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").key(0).getAsLegacyCellLink();

      const newValue = { [ID]: "item1", name: "First Item" };
      diffAndUpdate(
        current,
        newValue,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      const newDoc = testCell.getRaw().items[0]?.cell;

      const newValue2 = {
        items: [
          { [ID]: "item0", name: "Inserted before" },
          { [ID]: "item1", name: "Second Value" },
        ],
      };
      diffAndUpdate(
        testCell.getAsLegacyCellLink(),
        newValue2,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      expect(isAnyCellLink(testCell.getRaw().items[0])).toBe(true);
      expect(isAnyCellLink(testCell.getRaw().items[1])).toBe(true);
      expect(testCell.getRaw().items[0].cell).not.toBe(newDoc);
      expect(testCell.getRaw().items[0].cell.get().name).toEqual(
        "Inserted before",
      );
      expect(testCell.getRaw().items[1].cell).toBe(newDoc);
      expect(testCell.getRaw().items[1].cell.get().name).toEqual(
        "Second Value",
      );
    });

    it("should update the same document with numeric ID-based entity objects", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should update the same document with ID-based entity objects",
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").key(0).getAsLegacyCellLink();

      const newValue = { [ID]: 1, name: "First Item" };
      diffAndUpdate(
        current,
        newValue,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      const newDoc = testCell.getRaw().items[0].cell;

      const newValue2 = {
        items: [
          { [ID]: 0, name: "Inserted before" },
          { [ID]: 1, name: "Second Value" },
        ],
      };
      diffAndUpdate(
        testCell.getAsLegacyCellLink(),
        newValue2,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      expect(testCell.getRaw().items[0].cell).not.toBe(newDoc);
      expect(testCell.getRaw().items[0].cell.get().name).toEqual(
        "Inserted before",
      );
      expect(testCell.getRaw().items[1].cell).toBe(newDoc);
      expect(testCell.getRaw().items[1].cell.get().name).toEqual(
        "Second Value",
      );
    });

    it("should handle ID_FIELD redirects and reuse existing documents", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should handle ID_FIELD redirects",
      );
      testCell.set({ items: [] });

      // Create an initial item
      const data = { id: "item1", name: "First Item" };
      addCommonIDfromObjectID(data);
      diffAndUpdate(
        testCell.key("items").key(0).getAsLegacyCellLink(),
        data,
        undefined,
        "test ID_FIELD redirects",
      );

      const initialDoc = testCell.getRaw().items[0].cell;

      // Update with another item using ID_FIELD to point to the 'id' field
      const newValue = {
        items: [
          { id: "item0", name: "New Item" },
          { id: "item1", name: "Updated Item" },
        ],
      };
      addCommonIDfromObjectID(newValue);

      diffAndUpdate(
        testCell.getAsLegacyCellLink(),
        newValue,
        undefined,
        "test ID_FIELD redirects",
      );

      // Verify that the second item reused the existing document
      expect(isCellLink(testCell.getRaw().items[0])).toBe(true);
      expect(isCellLink(testCell.getRaw().items[1])).toBe(true);
      expect(testCell.getRaw().items[1].cell).toBe(initialDoc);
      expect(testCell.getRaw().items[1].cell.get().name).toEqual(
        "Updated Item",
      );
      expect(testCell.getRaw().items[0].cell.get().name).toEqual("New Item");
    });

    it("should treat different properties as different ID namespaces", () => {
      const testCell = runtime.getCell<any>(
        space,
        "it should treat different properties as different ID namespaces",
      );
      testCell.set(undefined);
      const current = testCell.getAsLegacyCellLink();

      const newValue = {
        a: { [ID]: "item1", name: "First Item" },
        b: { [ID]: "item1", name: "Second Item" }, // Same ID, different namespace
      };
      diffAndUpdate(
        current,
        newValue,
        undefined,
        "it should treat different properties as different ID namespaces",
      );

      expect(isCellLink(testCell.getRaw().a)).toBe(true);
      expect(isCellLink(testCell.getRaw().b)).toBe(true);
      expect(testCell.getRaw().a.cell).not.toBe(testCell.getRaw().b.cell);
      expect(testCell.getRaw().a.cell.get().name).toEqual("First Item");
      expect(testCell.getRaw().b.cell.get().name).toEqual("Second Item");
    });

    it("should return empty array when no changes", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "normalizeAndDiff no changes",
      );
      testCell.set({ value: 42 });
      const current = testCell.key("value").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, 42);

      expect(changes.length).toBe(0);
    });

    it("should handle doc and cell references", () => {
      const cellA = runtime.getCell<{ name: string }>(
        space,
        "normalizeAndDiff doc reference A",
      );
      cellA.set({ name: "Doc A" });
      const cellB = runtime.getCell<{ value: { name: string } }>(
        space,
        "normalizeAndDiff doc reference B",
      );
      cellB.set({ value: { name: "Original" } });

      const current = cellB.key("value").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, cellA.getDoc());

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expectCellLinksEqual(changes[0].value).toEqual(
        cellA.getAsLegacyCellLink(),
      );
    });

    it("should handle doc and cell references that don't change", () => {
      const cellA = runtime.getCell<{ name: string }>(
        space,
        "normalizeAndDiff doc reference no change A",
      );
      cellA.set({ name: "Doc A" });
      const cellB = runtime.getCell<{ value: { name: string } }>(
        space,
        "normalizeAndDiff doc reference no change B",
      );
      cellB.set({ value: { name: "Original" } });

      const current = cellB.key("value").getAsLegacyCellLink();
      const changes = normalizeAndDiff(current, cellA.getDoc());

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expectCellLinksEqual(changes[0].value).toEqual(
        cellA.getAsLegacyCellLink(),
      );

      applyChangeSet(changes);

      const changes2 = normalizeAndDiff(current, cellA.getDoc());

      expect(changes2.length).toBe(0);
    });
  });

  describe("addCommonIDfromObjectID", () => {
    it("should handle arrays", () => {
      const obj = { items: [{ id: "item1", name: "First Item" }] };
      addCommonIDfromObjectID(obj);
      expect((obj.items[0] as any)[ID_FIELD]).toBe("id");
    });

    it("should reuse items", () => {
      function isEqualCellLink(a: LegacyCellLink, b: LegacyCellLink): boolean {
        return isLegacyCellLink(a) && isLegacyCellLink(b) &&
          a.cell === b.cell &&
          arrayEqual(a.path, b.path);
      }

      const itemCell = runtime.getCell<{ id: string; name: string }>(
        space,
        "addCommonIDfromObjectID reuse items",
      );
      itemCell.set({ id: "item1", name: "Original Item" });

      const testCell = runtime.getCell<{ items: any[] }>(
        space,
        "addCommonIDfromObjectID arrays",
      );
      testCell.setRaw({ items: [itemCell.getAsLegacyCellLink()] });

      const data = {
        items: [{ id: "item1", name: "New Item" }, itemCell],
      };
      addCommonIDfromObjectID(data);
      diffAndUpdate(
        testCell.getAsLegacyCellLink(),
        data,
        undefined,
        "addCommonIDfromObjectID reuse items",
      );

      const result = testCell.getRaw();
      expect(isAnyCellLink(result.items[0])).toBe(true);
      expect(isAnyCellLink(result.items[1])).toBe(true);
      expect(isEqualCellLink(result.items[0] as any, result.items[1] as any))
        .toBe(true);
      expect(result.items[1].cell.get().name).toBe("New Item");
    });
  });
});

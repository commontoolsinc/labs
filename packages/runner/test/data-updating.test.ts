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
import { isEqualCellLink } from "../src/type-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { CellLink, isCellLink } from "../src/cell.ts";
import { type ReactivityLog } from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

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
      const testCell = runtime.documentMap.getDoc(
        { a: 1, b: { c: 2 } },
        "should set a value at a path 1",
        space,
      );
      const success = setNestedValue(testCell, ["b", "c"], 3);
      expect(success).toBe(true);
      expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
    });

    it("should delete no longer used fields when setting a nested value", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: 1, b: { c: 2, d: 3 } },
        "should delete no longer used fields 1",
        space,
      );
      const success = setNestedValue(testCell, ["b"], { c: 4 });
      expect(success).toBe(true);
      expect(testCell.get()).toEqual({ a: 1, b: { c: 4 } });
    });

    it("should log no changes when setting a nested value that is already set", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: 1, b: { c: 2 } },
        "should log no changes 1",
        space,
      );
      const log: ReactivityLog = { reads: [], writes: [] };
      const success = setNestedValue(testCell, [], { a: 1, b: { c: 2 } }, log);
      expect(success).toBe(true); // No changes is still a success
      expect(testCell.get()).toEqual({ a: 1, b: { c: 2 } });
      expect(log.writes).toEqual([]);
    });

    it("should log minimal changes when setting a nested value", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: 1, b: { c: 2 } },
        "should log minimal changes 1",
        space,
      );
      const log: ReactivityLog = { reads: [], writes: [] };
      const success = setNestedValue(testCell, [], { a: 1, b: { c: 3 } }, log);
      expect(success).toBe(true);
      expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
      expect(log.writes.length).toEqual(1);
      expect(log.writes[0].path).toEqual(["b", "c"]);
    });

    it("should fail when setting a nested value on a frozen cell", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: 1, b: { c: 2 } },
        "should fail when setting a nested value on a frozen cell 1",
        space,
      );
      testCell.freeze("test");
      const log: ReactivityLog = { reads: [], writes: [] };
      const success = setNestedValue(testCell, [], { a: 1, b: { c: 3 } }, log);
      expect(success).toBe(false);
    });

    it("should correctly update with shorter arrays", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: [1, 2, 3] },
        "should correctly update with shorter arrays 1",
        space,
      );
      const success = setNestedValue(testCell, ["a"], [1, 2]);
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2] });
    });

    it("should correctly update with a longer arrays", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: [1, 2, 3] },
        "should correctly update with a longer arrays 1",
        space,
      );
      const success = setNestedValue(testCell, ["a"], [1, 2, 3, 4]);
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2, 3, 4] });
    });

    it("should overwrite an object with an array", () => {
      const testCell = runtime.documentMap.getDoc(
        { a: { b: 1 } },
        "should overwrite an object with an array 1",
        space,
      );
      const success = setNestedValue(testCell, ["a"], [1, 2, 3]);
      expect(success).toBeTruthy();
      expect(testCell.get()).toHaveProperty("a");
      expect(testCell.get().a).toHaveLength(3);
      expect(testCell.getAsQueryResult().a).toEqual([1, 2, 3]);
    });
  });

  describe("normalizeAndDiff", () => {
    it("should detect simple value changes", () => {
      const testCell = runtime.documentMap.getDoc(
        { value: 42 },
        "normalizeAndDiff simple value changes",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["value"] };
      const changes = normalizeAndDiff(current, 100);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toBe(100);
    });

    it("should detect object property changes", () => {
      const testCell = runtime.documentMap.getDoc(
        { user: { name: "John", age: 30 } },
        "normalizeAndDiff object property changes",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["user"] };
      const changes = normalizeAndDiff(current, { name: "Jane", age: 30 });

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({
        cell: testCell,
        path: ["user", "name"],
      });
      expect(changes[0].value).toBe("Jane");
    });

    it("should detect added object properties", () => {
      const testCell = runtime.documentMap.getDoc(
        { user: { name: "John" } },
        "normalizeAndDiff added object properties",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["user"] };
      const changes = normalizeAndDiff(current, { name: "John", age: 30 });

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({
        cell: testCell,
        path: ["user", "age"],
      });
      expect(changes[0].value).toBe(30);
    });

    it("should detect removed object properties", () => {
      const testCell = runtime.documentMap.getDoc(
        { user: { name: "John", age: 30 } },
        "normalizeAndDiff removed object properties",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["user"] };
      const changes = normalizeAndDiff(current, { name: "John" });

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({
        cell: testCell,
        path: ["user", "age"],
      });
      expect(changes[0].value).toBe(undefined);
    });

    it("should handle array length changes", () => {
      const testCell = runtime.documentMap.getDoc(
        { items: [1, 2, 3] },
        "normalizeAndDiff array length changes",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["items"] };
      const changes = normalizeAndDiff(current, [1, 2]);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({
        cell: testCell,
        path: ["items", "length"],
        schema: { type: "number" },
        rootSchema: undefined,
      });
      expect(changes[0].value).toBe(2);
    });

    it("should handle array element changes", () => {
      const testCell = runtime.documentMap.getDoc(
        { items: [1, 2, 3] },
        "normalizeAndDiff array element changes",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["items"] };
      const changes = normalizeAndDiff(current, [1, 5, 3]);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({
        cell: testCell,
        path: ["items", "1"],
      });
      expect(changes[0].value).toBe(5);
    });

    it("should follow aliases", () => {
      const testCell = runtime.documentMap.getDoc(
        {
          value: 42,
          alias: { $alias: { path: ["value"] } },
        },
        "normalizeAndDiff follow aliases",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["alias"] };
      const changes = normalizeAndDiff(current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({ cell: testCell, path: ["value"] });
      expect(changes[0].value).toBe(100);
    });

    it("should update aliases", () => {
      const testCell = runtime.documentMap.getDoc(
        {
          value: 42,
          value2: 200,
          alias: { $alias: { path: ["value"] } },
        },
        "normalizeAndDiff update aliases",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["alias"] };
      const changes = normalizeAndDiff(current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({ cell: testCell, path: ["value"] });
      expect(changes[0].value).toBe(100);

      applyChangeSet(changes);

      const changes2 = normalizeAndDiff(current, {
        $alias: { path: ["value2"] },
      });

      applyChangeSet(changes2);

      expect(changes2.length).toBe(1);
      expect(changes2[0].location).toEqual({ cell: testCell, path: ["alias"] });
      expect(changes2[0].value).toEqual({ $alias: { path: ["value2"] } });

      const changes3 = normalizeAndDiff(current, 300);

      expect(changes3.length).toBe(1);
      expect(changes3[0].location).toEqual({
        cell: testCell,
        path: ["value2"],
      });
      expect(changes3[0].value).toBe(300);
    });

    it("should handle nested changes", () => {
      const testCell = runtime.documentMap.getDoc(
        {
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
        },
        "normalizeAndDiff nested changes",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["user", "profile"] };
      const changes = normalizeAndDiff(current, {
        details: {
          address: {
            city: "Boston",
            zipcode: 10001,
          },
        },
      });

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual({
        cell: testCell,
        path: ["user", "profile", "details", "address", "city"],
      });
      expect(changes[0].value).toBe("Boston");
    });

    it("should handle ID-based entity objects", () => {
      const testCell = runtime.documentMap.getDoc(
        { items: [] },
        "should handle ID-based entity objects",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["items", 0] };

      const newValue = { [ID]: "item1", name: "First Item" };
      const changes = normalizeAndDiff(
        current,
        newValue,
        undefined,
        "should handle ID-based entity objects",
      );

      // Should create an entity and return changes to that entity
      expect(changes.length).toBe(3);
      expect(changes[0].location.cell).toBe(testCell);
      expect(changes[0].location.path).toEqual(["items", 0]);
      expect(changes[1].location.cell).not.toBe(changes[0].location.cell);
      expect(changes[1].location.path).toEqual([]);
      expect(changes[2].location.cell).toBe(changes[1].location.cell);
      expect(changes[2].location.path).toEqual(["name"]);
    });

    it("should update the same document with ID-based entity objects", () => {
      const testDoc = runtime.documentMap.getDoc<any>(
        { items: [] },
        "should update the same document with ID-based entity objects",
        space,
      );
      const current: CellLink = { cell: testDoc, path: ["items", 0] };

      const newValue = { [ID]: "item1", name: "First Item" };
      diffAndUpdate(
        current,
        newValue,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      const newDoc = testDoc.get().items[0].cell;

      const newValue2 = {
        items: [
          { [ID]: "item0", name: "Inserted before" },
          { [ID]: "item1", name: "Second Value" },
        ],
      };
      diffAndUpdate(
        { cell: testDoc, path: [] },
        newValue2,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      expect(testDoc.get().items[0].cell).not.toBe(newDoc);
      expect(testDoc.get().items[0].cell.get().name).toEqual("Inserted before");
      expect(testDoc.get().items[1].cell).toBe(newDoc);
      expect(testDoc.get().items[1].cell.get().name).toEqual("Second Value");
    });

    it("should update the same document with numeric ID-based entity objects", () => {
      const testDoc = runtime.documentMap.getDoc<any>(
        { items: [] },
        "should update the same document with ID-based entity objects",
        space,
      );
      const current: CellLink = { cell: testDoc, path: ["items", 0] };

      const newValue = { [ID]: 1, name: "First Item" };
      diffAndUpdate(
        current,
        newValue,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      const newDoc = testDoc.get().items[0].cell;

      const newValue2 = {
        items: [
          { [ID]: 0, name: "Inserted before" },
          { [ID]: 1, name: "Second Value" },
        ],
      };
      diffAndUpdate(
        { cell: testDoc, path: [] },
        newValue2,
        undefined,
        "should update the same document with ID-based entity objects",
      );

      expect(testDoc.get().items[0].cell).not.toBe(newDoc);
      expect(testDoc.get().items[0].cell.get().name).toEqual("Inserted before");
      expect(testDoc.get().items[1].cell).toBe(newDoc);
      expect(testDoc.get().items[1].cell.get().name).toEqual("Second Value");
    });

    it("should handle ID_FIELD redirects and reuse existing documents", () => {
      const testDoc = runtime.documentMap.getDoc<any>(
        { items: [] },
        "should handle ID_FIELD redirects",
        space,
      );

      // Create an initial item
      const data = { id: "item1", name: "First Item" };
      addCommonIDfromObjectID(data);
      diffAndUpdate(
        { cell: testDoc, path: ["items", 0] },
        data,
        undefined,
        "test ID_FIELD redirects",
      );

      const initialDoc = testDoc.get().items[0].cell;

      // Update with another item using ID_FIELD to point to the 'id' field
      const newValue = {
        items: [
          { id: "item0", name: "New Item" },
          { id: "item1", name: "Updated Item" },
        ],
      };
      addCommonIDfromObjectID(newValue);

      diffAndUpdate(
        { cell: testDoc, path: [] },
        newValue,
        undefined,
        "test ID_FIELD redirects",
      );

      // Verify that the second item reused the existing document
      expect(isCellLink(testDoc.get().items[0])).toBe(true);
      expect(isCellLink(testDoc.get().items[1])).toBe(true);
      expect(testDoc.get().items[1].cell).toBe(initialDoc);
      expect(testDoc.get().items[1].cell.get().name).toEqual("Updated Item");
      expect(testDoc.get().items[0].cell.get().name).toEqual("New Item");
    });

    it("should treat different properties as different ID namespaces", () => {
      const testDoc = runtime.documentMap.getDoc<any>(
        undefined,
        "it should treat different properties as different ID namespaces",
        space,
      );
      const current: CellLink = { cell: testDoc, path: [] };

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

      expect(isCellLink(testDoc.get().a)).toBe(true);
      expect(isCellLink(testDoc.get().b)).toBe(true);
      expect(testDoc.get().a.cell).not.toBe(testDoc.get().b.cell);
      expect(testDoc.get().a.cell.get().name).toEqual("First Item");
      expect(testDoc.get().b.cell.get().name).toEqual("Second Item");
    });

    it("should return empty array when no changes", () => {
      const testCell = runtime.documentMap.getDoc(
        { value: 42 },
        "normalizeAndDiff no changes",
        space,
      );
      const current: CellLink = { cell: testCell, path: ["value"] };
      const changes = normalizeAndDiff(current, 42);

      expect(changes.length).toBe(0);
    });

    it("should handle doc and cell references", () => {
      const docA = runtime.documentMap.getDoc(
        { name: "Doc A" },
        "normalizeAndDiff doc reference A",
        space,
      );
      const docB = runtime.documentMap.getDoc(
        { value: { name: "Original" } },
        "normalizeAndDiff doc reference B",
        space,
      );

      const current: CellLink = { cell: docB, path: ["value"] };
      const changes = normalizeAndDiff(current, docA);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toEqual({ cell: docA, path: [] });
    });

    it("should handle doc and cell references that don't change", () => {
      const docA = runtime.documentMap.getDoc(
        { name: "Doc A" },
        "normalizeAndDiff doc reference no change A",
        space,
      );
      const docB = runtime.documentMap.getDoc(
        { value: { name: "Original" } },
        "normalizeAndDiff doc reference no change B",
        space,
      );

      const current: CellLink = { cell: docB, path: ["value"] };
      const changes = normalizeAndDiff(current, docA);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toEqual({ cell: docA, path: [] });

      applyChangeSet(changes);

      const changes2 = normalizeAndDiff(current, docA);

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
      const itemDoc = runtime.documentMap.getDoc(
        { id: "item1", name: "Original Item" },
        "addCommonIDfromObjectID reuse items",
        space,
      );
      const testDoc = runtime.documentMap.getDoc(
        { items: [{ cell: itemDoc, path: [] }] },
        "addCommonIDfromObjectID arrays",
        space,
      );

      const data = {
        items: [{ id: "item1", name: "New Item" }, itemDoc.asCell()],
      };
      addCommonIDfromObjectID(data);
      diffAndUpdate(
        { cell: testDoc, path: [] },
        data,
        undefined,
        "addCommonIDfromObjectID reuse items",
      );

      const result = testDoc.get();
      expect(isCellLink(result.items[0])).toBe(true);
      expect(isCellLink(result.items[1])).toBe(true);
      expect(isEqualCellLink(result.items[0] as any, result.items[1] as any))
        .toBe(
          true,
        );
      expect(result.items[1].cell.get().name).toBe("New Item");
    });
  });
});

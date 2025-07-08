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
  areLinksSame,
  areNormalizedLinksSame,
  isAnyCellLink,
  isLegacyCellLink,
  isLegacyDocCellLink,
  parseLink,
} from "../src/link-utils.ts";
import type { LegacyDocCellLink } from "../src/sigil-types.ts";
import { arrayEqual } from "../src/path-utils.ts";
import { type ReactivityLog } from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("data-updating", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      blobbyServerUrl: import.meta.url,
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.commit();
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
      testCell.freeze("test");
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
      const current = testCell.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 100);

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
      const current = testCell.key("user").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, {
        name: "Jane",
        age: 30,
      });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("name").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
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
      const current = testCell.key("user").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, {
        name: "John",
        age: 30,
      });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("age").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(30);
    });

    it("should detect removed object properties", () => {
      const testCell = runtime.getCell<{ user: { name: string; age: number } }>(
        space,
        "normalizeAndDiff removed object properties",
      );
      testCell.set({ user: { name: "John", age: 30 } });
      const current = testCell.key("user").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, { name: "John" });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("age").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(undefined);
    });

    it("should handle array length changes", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array length changes",
      );
      testCell.set({ items: [1, 2, 3] });
      const current = testCell.key("items").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, [1, 2]);

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("items").key("length").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(2);
    });

    it("should handle array element changes", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array element changes",
      );
      testCell.set({ items: [1, 2, 3] });
      const current = testCell.key("items").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, [1, 5, 3]);

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("items").key(1).getAsNormalizedFullLink(),
        ),
      ).toBe(true);
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
      const current = testCell.key("alias").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("value").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
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
      const current = testCell.key("alias").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 100);

      // Should follow alias to value and change it there
      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("value").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe(100);

      applyChangeSet(tx, changes);

      const changes2 = normalizeAndDiff(runtime, tx, current, {
        $alias: { path: ["value2"] },
      });

      console.log(
        JSON.stringify(current, null, 2),
        JSON.stringify(changes2, null, 2),
      );
      applyChangeSet(tx, changes2);

      expect(changes2.length).toBe(1);
      console.log(
        JSON.stringify(testCell.getRaw(), null, 2),
        parseLink(current),
        parseLink(changes2[0].location),
        parseLink(testCell.key("alias")),
      );
      expect(
        areNormalizedLinksSame(
          changes2[0].location,
          testCell.key("alias").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes2[0].value).toEqual({ $alias: { path: ["value2"] } });

      const changes3 = normalizeAndDiff(runtime, tx, current, 300);

      expect(changes3.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes3[0].location,
          testCell.key("value2").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
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
      const current = testCell.key("user").key("profile")
        .getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, {
        details: {
          address: {
            city: "Boston",
            zipcode: 10001,
          },
        },
      });

      expect(changes.length).toBe(1);
      expect(
        areNormalizedLinksSame(
          changes[0].location,
          testCell.key("user").key("profile").key("details").key("address").key(
            "city",
          ).getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(changes[0].value).toBe("Boston");
    });

    it("should handle ID-based entity objects", () => {
      const testCell = runtime.getCell<{ items: any[] }>(
        space,
        "should handle ID-based entity objects",
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").key(0).getAsNormalizedFullLink();

      const newValue = { [ID]: "item1", name: "First Item" };
      const changes = normalizeAndDiff(
        runtime,
        tx,
        current,
        newValue,
        "should handle ID-based entity objects",
      );

      // Should create an entity and return changes to that entity
      expect(changes.length).toBe(3);
      console.log(
        JSON.stringify(changes, null, 2),
        testCell.key("items").key(0).getAsNormalizedFullLink(),
      );
      expect(changes[0].location.id).toEqual(
        testCell.getAsNormalizedFullLink().id,
      );
      expect(changes[0].location.path).toEqual(["items", "0"]);
      expect(changes[1].location.id).not.toEqual(changes[0].location.id);
      expect(changes[1].location.path).toEqual([]);
      expect(changes[2].location.id).toEqual(changes[1].location.id);
      expect(changes[2].location.path).toEqual(["name"]);
    });

    it("should update the same document with ID-based entity objects", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should update the same document with ID-based entity objects",
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").key(0).getAsNormalizedFullLink();

      const newValue = { [ID]: "item1", name: "First Item" };
      diffAndUpdate(
        runtime,
        tx,
        current,
        newValue,
        "should update the same document with ID-based entity objects",
      );

      const newLink = testCell.getRaw().items[0];

      const newValue2 = {
        items: [
          { [ID]: "item0", name: "Inserted before" },
          { [ID]: "item1", name: "Second Value" },
        ],
      };
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        newValue2,
        "should update the same document with ID-based entity objects",
      );

      expect(isAnyCellLink(testCell.getRaw().items[0])).toBe(true);
      expect(isAnyCellLink(testCell.getRaw().items[1])).toBe(true);
      expect(areLinksSame(testCell.getRaw().items[0], newLink)).toBe(false);
      expect(
        (tx.readValueOrThrow(
          parseLink(testCell.getRaw().items[0], testCell)!,
        ) as any)
          .name,
      )
        .toEqual("Inserted before");
      expect(areLinksSame(testCell.getRaw().items[1], newLink)).toBe(true);
      expect(
        (tx.readValueOrThrow(
          parseLink(testCell.getRaw().items[1], testCell)!,
        ) as any)
          .name,
      )
        .toEqual("Second Value");
    });

    it("should update the same document with numeric ID-based entity objects", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should update the same document with ID-based entity objects",
      );
      testCell.set({ items: [] });
      const current = testCell.key("items").key(0).getAsNormalizedFullLink();

      const newValue = { [ID]: 1, name: "First Item" };
      diffAndUpdate(
        runtime,
        tx,
        current,
        newValue,
        "should update the same document with ID-based entity objects",
      );

      const newLink = testCell.getRaw().items[0];

      const newValue2 = {
        items: [
          { [ID]: 0, name: "Inserted before" },
          { [ID]: 1, name: "Second Value" },
        ],
      };
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        newValue2,
        "should update the same document with ID-based entity objects",
      );

      expect(areLinksSame(testCell.getRaw().items[0], newLink)).toBe(false);
      expect(
        (tx.readValueOrThrow(
          parseLink(testCell.getRaw().items[0], testCell)!,
        ) as any)
          .name,
      )
        .toEqual("Inserted before");
      expect(areLinksSame(testCell.getRaw().items[1], newLink)).toBe(true);
      expect(
        (tx.readValueOrThrow(
          parseLink(testCell.getRaw().items[1], testCell)!,
        ) as any)
          .name,
      )
        .toEqual("Second Value");
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
        runtime,
        tx,
        testCell.key("items").key(0).getAsNormalizedFullLink(),
        data,
        "test ID_FIELD redirects",
      );

      const initialLink = testCell.getRaw().items[0];

      // Update with another item using ID_FIELD to point to the 'id' field
      const newValue = {
        items: [
          { id: "item0", name: "New Item" },
          { id: "item1", name: "Updated Item" },
        ],
      };
      addCommonIDfromObjectID(newValue);

      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        newValue,
        "test ID_FIELD redirects",
      );

      // Verify that the second item reused the existing document
      expect(isAnyCellLink(testCell.getRaw().items[0])).toBe(true);
      expect(isAnyCellLink(testCell.getRaw().items[1])).toBe(true);
      expect(areLinksSame(testCell.getRaw().items[1], initialLink)).toBe(true);
      expect(
        (tx.readValueOrThrow(
          parseLink(testCell.getRaw().items[1], testCell)!,
        ) as any)
          .name,
      )
        .toEqual(
          "Updated Item",
        );
      expect(
        (tx.readValueOrThrow(
          parseLink(testCell.getRaw().items[0], testCell)!,
        ) as any)
          .name,
      )
        .toEqual("New Item");
    });

    it("should treat different properties as different ID namespaces", () => {
      const testCell = runtime.getCell<any>(
        space,
        "it should treat different properties as different ID namespaces",
      );
      testCell.set(undefined);
      const current = testCell.getAsNormalizedFullLink();

      const newValue = {
        a: { [ID]: "item1", name: "First Item" },
        b: { [ID]: "item1", name: "Second Item" }, // Same ID, different namespace
      };
      diffAndUpdate(
        runtime,
        tx,
        current,
        newValue,
        "it should treat different properties as different ID namespaces",
      );

      expect(isAnyCellLink(testCell.getRaw().a)).toBe(true);
      expect(isAnyCellLink(testCell.getRaw().b)).toBe(true);
      expect(areLinksSame(testCell.getRaw().a, testCell.getRaw().b)).toBe(
        false,
      );
      expect(
        (tx.readValueOrThrow(parseLink(testCell.getRaw().a, testCell)!) as any)
          .name,
      )
        .toEqual("First Item");
      expect(
        (tx.readValueOrThrow(parseLink(testCell.getRaw().b, testCell)!) as any)
          .name,
      )
        .toEqual("Second Item");
    });

    it("should return empty array when no changes", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "normalizeAndDiff no changes",
      );
      testCell.set({ value: 42 });
      const current = testCell.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, 42);

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

      const current = cellB.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, cellA);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(areLinksSame(changes[0].value, cellA)).toBe(true);
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

      const current = cellB.key("value").getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, current, cellA);

      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(areLinksSame(changes[0].value, cellA)).toBe(true);

      applyChangeSet(tx, changes);

      const changes2 = normalizeAndDiff(runtime, tx, current, cellA);

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
      const itemCell = runtime.getCell<{ id: string; name: string }>(
        space,
        "addCommonIDfromObjectID reuse items",
      );
      itemCell.set({ id: "item1", name: "Original Item" });

      const testCell = runtime.getCell<{ items: any[] }>(
        space,
        "addCommonIDfromObjectID arrays",
      );
      testCell.setRaw({ items: [itemCell.getAsLink()] });

      const data = {
        items: [{ id: "item1", name: "New Item" }, itemCell],
      };
      addCommonIDfromObjectID(data);
      diffAndUpdate(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        data,
        "addCommonIDfromObjectID reuse items",
      );

      const result = testCell.getRaw();
      expect(isAnyCellLink(result.items[0])).toBe(true);
      expect(isAnyCellLink(result.items[1])).toBe(true);
      expect(areLinksSame(result.items[0], result.items[1]))
        .toBe(true);
      expect(
        (tx.readValueOrThrow(parseLink(result.items[1], testCell)!) as any)
          .name,
      )
        .toBe("New Item");
    });
  });
});

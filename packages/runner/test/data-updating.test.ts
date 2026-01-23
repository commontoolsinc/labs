import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ID, ID_FIELD, JSONSchema } from "../src/builder/types.ts";
import {
  addCommonIDfromObjectID,
  applyChangeSet,
  type ChangeSet,
  compactChangeSet,
  diffAndUpdate,
  normalizeAndDiff,
} from "../src/data-updating.ts";
import { Runtime } from "../src/runtime.ts";
import {
  areLinksSame,
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  isPrimitiveCellLink,
  isSigilLink,
  parseLink,
} from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

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
      apiUrl: new URL(import.meta.url),
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
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2 } });
      diffAndUpdate(
        runtime,
        tx,
        testCell.key("b").key("c").getAsNormalizedFullLink(),
        3,
      );
      expect(testCell.get()).toEqual({ a: 1, b: { c: 3 } });
    });

    it("should delete no longer used fields when setting a nested value", () => {
      const testCell = runtime.getCell<
        { a: number; b: { c: number; d?: number } }
      >(
        space,
        "should delete no longer used fields 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2, d: 3 } });
      diffAndUpdate(runtime, tx, testCell.key("b").getAsNormalizedFullLink(), {
        c: 4,
      });
      expect(testCell.get()).toEqual({ a: 1, b: { c: 4 } });
    });

    it("should log no changes when setting a nested value that is already set", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should log no changes 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const changes = normalizeAndDiff(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        {
          a: 1,
          b: { c: 2 },
        },
      );
      expect(changes.length).toEqual(0);
    });

    it("should log minimal changes when setting a nested value", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should log minimal changes 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2 } });
      const changes = normalizeAndDiff(
        runtime,
        tx,
        testCell.getAsNormalizedFullLink(),
        {
          a: 1,
          b: { c: 3 },
        },
      );
      expect(changes.length).toEqual(1);
      expect(changes[0].location.path).toEqual(["b", "c"]);
    });

    // Frozen cells are not freezing the underlying document right now.
    it.skip("should fail when setting a nested value on a frozen cell", () => {
      const testCell = runtime.getCell<{ a: number; b: { c: number } }>(
        space,
        "should fail when setting a nested value on a frozen cell 1",
        undefined,
        tx,
      );
      testCell.set({ a: 1, b: { c: 2 } });
      testCell.freeze("test");
      expect(() =>
        diffAndUpdate(runtime, tx, testCell.getAsNormalizedFullLink(), {
          a: 1,
          b: { c: 3 },
        })
      ).toThrow();
    });

    it("should correctly update with shorter arrays", () => {
      const testCell = runtime.getCell<{ a: number[] }>(
        space,
        "should correctly update with shorter arrays 1",
        undefined,
        tx,
      );
      testCell.set({ a: [1, 2, 3] });
      const success = diffAndUpdate(
        runtime,
        tx,
        testCell.key("a").getAsNormalizedFullLink(),
        [1, 2],
      );
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2] });
    });

    it("should correctly update with a longer arrays", () => {
      const testCell = runtime.getCell<{ a: number[] }>(
        space,
        "should correctly update with a longer arrays 1",
        undefined,
        tx,
      );
      testCell.set({ a: [1, 2, 3] });
      const success = diffAndUpdate(
        runtime,
        tx,
        testCell.key("a").getAsNormalizedFullLink(),
        [1, 2, 3, 4],
      );
      expect(success).toBe(true);
      expect(testCell.getAsQueryResult()).toEqual({ a: [1, 2, 3, 4] });
    });

    it("should overwrite an object with an array", () => {
      const testCell = runtime.getCell<{ a: any }>(
        space,
        "should overwrite an object with an array 1",
        undefined,
        tx,
      );
      testCell.set({ a: { b: 1 } });
      const success = diffAndUpdate(
        runtime,
        tx,
        testCell.key("a").getAsNormalizedFullLink(),
        [1, 2, 3],
      );
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
        undefined,
        tx,
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
        undefined,
        tx,
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
        undefined,
        tx,
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
        undefined,
        tx,
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
        undefined,
        tx,
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

    it("should generate correct paths when setting array length to 0", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array length to zero",
        undefined,
        tx,
      );
      // Create array with 100 items
      const largeArray = Array.from({ length: 100 }, (_, i) => i);
      testCell.set({ items: largeArray });

      // Now set length to 0 through the length property
      const lengthLink = testCell.key("items").key("length")
        .getAsNormalizedFullLink();
      const changes = normalizeAndDiff(runtime, tx, lengthLink, 0);

      // Should have 101 changes total
      expect(changes.length).toBe(101);

      // Find the length change
      const lengthChange = changes.find((c) =>
        c.location.path[c.location.path.length - 1] === "length"
      );
      expect(lengthChange).toBeDefined();
      expect(lengthChange!.value).toBe(0);

      // Verify all elements are marked undefined with correct paths
      const elementChanges = changes.filter((c) =>
        c.location.path[c.location.path.length - 1] !== "length"
      );
      expect(elementChanges.length).toBe(100);

      elementChanges.forEach((change, i) => {
        expect(change.location.path).toEqual(["items", i.toString()]);
        expect(change.value).toBe(undefined);
      });
    });

    it("should handle array element changes", () => {
      const testCell = runtime.getCell<{ items: number[] }>(
        space,
        "normalizeAndDiff array element changes",
        undefined,
        tx,
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
        undefined,
        tx,
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
        undefined,
        tx,
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

      applyChangeSet(tx, changes2);

      expect(changes2.length).toBe(1);
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
        undefined,
        tx,
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
        undefined,
        tx,
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
        undefined,
        tx,
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

      expect(isPrimitiveCellLink(testCell.getRaw().items[0])).toBe(true);
      expect(isPrimitiveCellLink(testCell.getRaw().items[1])).toBe(true);
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
        undefined,
        tx,
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
        undefined,
        tx,
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
      expect(isPrimitiveCellLink(testCell.getRaw().items[0])).toBe(true);
      expect(isPrimitiveCellLink(testCell.getRaw().items[1])).toBe(true);
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
        undefined,
        tx,
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

      expect(isPrimitiveCellLink(testCell.getRaw().a)).toBe(true);
      expect(isPrimitiveCellLink(testCell.getRaw().b)).toBe(true);
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
        undefined,
        tx,
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
        undefined,
        tx,
      );
      cellA.set({ name: "Doc A" });
      const cellB = runtime.getCell<{ value: { name: string } }>(
        space,
        "normalizeAndDiff doc reference B",
        undefined,
        tx,
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
        undefined,
        tx,
      );
      cellA.set({ name: "Doc A" });
      const cellB = runtime.getCell<{ value: { name: string } }>(
        space,
        "normalizeAndDiff doc reference no change B",
        undefined,
        tx,
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

    it("should handle data: URI links by writing their contents", () => {
      // Create a data cell with some content using getImmutableCell
      // This creates a cell with an actual data: URI that should trigger the data URI handling
      const dataCell = runtime.getImmutableCell<
        { message: string; count: number }
      >(
        space,
        { message: "Hello from data", count: 42 },
        undefined,
        tx,
      );

      // Create a target cell to write to
      const targetCell = runtime.getCell<{ value: any }>(
        space,
        "normalizeAndDiff data URI target",
        undefined,
        tx,
      );
      targetCell.set({ value: "original" });

      const current = targetCell.key("value").getAsNormalizedFullLink();

      // Write the data cell link to the target
      const changes = normalizeAndDiff(runtime, tx, current, dataCell);

      // Should write the contents of the data cell, not the link itself
      // The data URI handling writes each property individually
      expect(changes.length).toBe(3);

      // Find the changes for each property
      const messageChange = changes.find((c) =>
        c.location.path.includes("message")
      );
      const countChange = changes.find((c) =>
        c.location.path.includes("count")
      );
      const objectChange = changes.find((c) => c.location.path.length === 1);

      expect(messageChange).toBeDefined();
      expect(messageChange!.value).toBe("Hello from data");
      expect(countChange).toBeDefined();
      expect(countChange!.value).toBe(42);
      expect(objectChange).toBeDefined();
      expect(objectChange!.value).toEqual({});
    });

    it("should handle data: URI links with nested paths", () => {
      // Create a data cell with nested content using getImmutableCell
      const dataCell = runtime.getImmutableCell<{
        nested: {
          deep: {
            value: string;
            numbers: number[];
          };
        };
      }>(
        space,
        {
          nested: {
            deep: {
              value: "nested value",
              numbers: [1, 2, 3],
            },
          },
        },
        undefined,
        tx,
      );

      // Create a target cell
      const targetCell = runtime.getCell<{ result: any }>(
        space,
        "normalizeAndDiff data URI nested target",
        undefined,
        tx,
      );
      targetCell.set({ result: "original" });

      const current = targetCell.key("result").getAsNormalizedFullLink();

      // Create a link to a nested path in the data cell
      const nestedDataLink = dataCell.key("nested").key("deep").getAsLink();

      // Write the nested data link to the target
      const changes = normalizeAndDiff(runtime, tx, current, nestedDataLink);

      // Should write the contents at the nested path
      // The data URI handling writes each property individually
      expect(changes.length).toBe(6);

      // Find the changes for each property
      const valueChange = changes.find((c) =>
        c.location.path.includes("value") &&
        !c.location.path.includes("numbers")
      );
      const numbersArrayChange = changes.find((c) =>
        c.location.path.length === 2 && c.location.path[1] === "numbers"
      );
      const numbersElements = changes.filter((c) =>
        c.location.path.length === 3 && c.location.path[1] === "numbers"
      );

      expect(valueChange).toBeDefined();
      expect(valueChange!.value).toBe("nested value");
      expect(numbersArrayChange).toBeDefined();
      expect(numbersArrayChange!.value).toEqual([]);
      expect(numbersElements).toHaveLength(3);
      expect(numbersElements[0].value).toBe(1);
      expect(numbersElements[1].value).toBe(2);
      expect(numbersElements[2].value).toBe(3);
    });

    it("should handle data: URI links that resolve to undefined", () => {
      // Create a data cell with some content using getImmutableCell
      const dataCell = runtime.getImmutableCell<{ exists: string }>(
        space,
        { exists: "this exists" },
        undefined,
        tx,
      );

      // Create a target cell
      const targetCell = runtime.getCell<{ value: any }>(
        space,
        "normalizeAndDiff data URI undefined target",
        undefined,
        tx,
      );
      targetCell.set({ value: "original" });

      const current = targetCell.key("value").getAsNormalizedFullLink();

      // Create a link to a non-existent path in the data cell
      // Use getAsLink() directly on the cell and then manually construct the path
      const dataLink = dataCell.getAsLink();
      const nonExistentLink = createSigilLinkFromParsedLink({
        ...parseLink(dataLink),
        path: ["doesNotExist"],
      });

      // Write the non-existent data link to the target
      const changes = normalizeAndDiff(runtime, tx, current, nonExistentLink);

      // Should write undefined since the path doesn't exist
      expect(changes.length).toBe(1);
      expect(changes[0].location).toEqual(current);
      expect(changes[0].value).toBeUndefined();
    });

    it("should handle data: URI links that contain nested links", () => {
      // Create a regular cell that will be referenced
      const referencedCell = runtime.getCell<{ name: string; value: number }>(
        space,
        "data URI nested link referenced",
        undefined,
        tx,
      );
      referencedCell.set({ name: "Referenced Cell", value: 100 });

      // Create a data cell that contains a link to the referenced cell
      const dataCell = runtime.getImmutableCell<{
        title: string;
        reference: any;
        metadata: { description: string };
      }>(
        space,
        {
          title: "Data with Link",
          reference: referencedCell.getAsLink(),
          metadata: { description: "Contains a nested link" },
        },
        undefined,
        tx,
      );

      // Create a target cell to write to
      const targetCell = runtime.getCell<{ result: any }>(
        space,
        "normalizeAndDiff data URI nested link target",
        undefined,
        tx,
      );
      targetCell.set({ result: "original" });

      const current = targetCell.key("result").getAsNormalizedFullLink();

      // Write the data cell link to the target
      const changes = normalizeAndDiff(runtime, tx, current, dataCell);
      // Should write the contents of the data cell, resolving nested links
      expect(changes.length).toBe(5);

      // Find the changes for each property
      const titleChange = changes.find((c) =>
        c.location.path.includes("title")
      );
      const referenceChange = changes.find((c) =>
        c.location.path.includes("reference")
      );
      const metadataChange = changes.find((c) =>
        c.location.path.length === 3 &&
        c.location.path[1] === "metadata" &&
        c.location.path[2] === "description"
      );
      const objectChange = changes.find((c) => c.location.path.length === 1);

      expect(titleChange).toBeDefined();
      expect(titleChange!.value).toBe("Data with Link");
      expect(referenceChange).toBeDefined();
      // The reference should be resolved to the actual cell link
      expect(isPrimitiveCellLink(referenceChange!.value)).toBe(true);
      expect(metadataChange).toBeDefined();
      expect(metadataChange!.value).toEqual("Contains a nested link");
      expect(objectChange).toBeDefined();
      expect(objectChange!.value).toEqual({});

      applyChangeSet(tx, changes);

      const value = targetCell.get();
      expect(value.result).toEqual({
        title: "Data with Link",
        reference: { name: "Referenced Cell", value: 100 },
        metadata: { description: "Contains a nested link" },
      });
    });
  });

  it("should handle data: URI links that contain nested links and references go through it", () => {
    // Create a regular cell that will be referenced
    const referencedCell = runtime.getCell(
      space,
      "data URI nested link referenced",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          nested: { type: "object", properties: { value: { type: "number" } } },
        },
      } as const satisfies JSONSchema,
      tx,
    );
    referencedCell.set({ name: "Referenced Cell", nested: { value: 100 } });

    // Create a data cell that contains a link to the referenced cell
    const dataCell = runtime.getImmutableCell<{
      title: string;
      reference: any;
      metadata: { description: string };
    }>(
      space,
      {
        title: "Data with Link",
        reference: referencedCell.key("nested").getAsLink(),
        metadata: { description: "Contains a nested link" },
      },
      undefined,
      tx,
    );

    // Create a target cell to write to
    const targetCell = runtime.getCell<{ result: any }>(
      space,
      "normalizeAndDiff data URI nested link target",
      undefined,
      tx,
    );
    targetCell.set({ result: "original" });

    const current = targetCell.key("result").getAsNormalizedFullLink();

    // Write the data cell link to the target
    const changes = normalizeAndDiff(
      runtime,
      tx,
      current,
      dataCell.key("reference").key("value").getAsLink(),
    );

    // Should write the contents of the data cell, resolving nested links
    expect(changes.length).toBe(1);

    applyChangeSet(tx, changes);

    const value = targetCell.get();
    expect(value.result).toBe(100);
  });

  it("should inline data URI containing redirect without writing redirect to wrong location", () => {
    // Setup: Create two separate cells - source and destination
    const sourceCell = runtime.getCell<{ value: number }>(
      space,
      "data URI redirect source value",
      undefined,
      tx,
    );
    sourceCell.set({ value: 99 });

    const destinationCell = runtime.getCell<{ value: number }>(
      space,
      "data URI redirect destination value",
      undefined,
      tx,
    );
    destinationCell.set({ value: 42 });

    // Create a data URI that contains a redirect pointing to sourceCell
    const redirectAlias = sourceCell.key("value").getAsWriteRedirectLink();
    const dataCell = runtime.getImmutableCell<any>(
      space,
      redirectAlias,
      undefined,
      tx,
    );

    // Create a target cell that currently has an alias to destinationCell
    const targetCell = runtime.getCell<{ result: any }>(
      space,
      "data URI redirect target cell",
      undefined,
      tx,
    );
    targetCell.setRaw({
      result: destinationCell.key("value").getAsWriteRedirectLink(),
    });

    const current = targetCell.key("result").getAsNormalizedFullLink();

    // Write the data cell (which contains a redirect to sourceCell) to the target
    // Before the fix: data URI was not inlined early enough, and the redirect
    // would be written to destinationCell.value instead of target.result
    // After the fix: data URI is inlined first, exposing the redirect, which is
    // then properly written to target.result
    const changes = normalizeAndDiff(
      runtime,
      tx,
      current,
      dataCell.getAsLink(),
    );

    // Should write the new redirect to target Cell.result
    // Note: The change writes a redirect (alias object with $alias key)
    expect(changes.length).toBe(1);
    expect(changes[0].location.id).toBe(
      targetCell.getAsNormalizedFullLink().id,
    );
    expect(changes[0].location.path).toEqual(["result"]);
    // The value should be the redirect link
    expect(isSigilLink(changes[0].value)).toBe(true);
    const parsedLink = parseLink(changes[0].value);
    expect(parsedLink?.overwrite).toBe("redirect");

    applyChangeSet(tx, changes);

    // Verify that targetCell now points to sourceCell's value (99), not destinationCell's (42)
    expect(targetCell.get().result).toBe(99);

    // Verify neither source nor destination cells were modified
    expect(sourceCell.get()).toEqual({ value: 99 });
    expect(destinationCell.get()).toEqual({ value: 42 });
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
        undefined,
        tx,
      );
      itemCell.set({ id: "item1", name: "Original Item" });

      const testCell = runtime.getCell<{ items: any[] }>(
        space,
        "addCommonIDfromObjectID arrays",
        undefined,
        tx,
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
      expect(isPrimitiveCellLink(result?.items[0])).toBe(true);
      expect(isPrimitiveCellLink(result?.items[1])).toBe(true);
      expect(areLinksSame(result?.items[0], result?.items[1]))
        .toBe(true);
      expect(
        (tx.readValueOrThrow(parseLink(result?.items[1], testCell)!) as any)
          .name,
      )
        .toBe("New Item");
    });
  });

  describe("getRaw followed by setRaw works", () => {
    it("should work", () => {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "getRaw followed by setRaw works",
      );
      cell.withTx(tx).setRaw({ value: 42 });
      const raw = cell.withTx(tx).getRaw();
      expect(raw?.value).toBe(42);
      cell.withTx(tx).setRaw(raw);
      expect(cell.withTx(tx).get().value).toBe(42);
    });
  });
});

/**
 * Tests for compactChangeSet - a pure function that removes redundant child
 * path changes when a parent path change already includes that data.
 */
describe("compactChangeSet", () => {
  // Helper to create a change at a specific path
  const makeChange = (
    path: string[],
    value: unknown,
    docId: `${string}:${string}` = "test:doc",
    docSpace: `did:${string}:${string}` = "did:test:space",
  ): ChangeSet[0] => ({
    location: {
      id: docId,
      space: docSpace,
      type: "application/json",
      path,
    },
    value: value as any,
  });

  describe("basic cases", () => {
    it("should return single change unchanged", () => {
      const changes: ChangeSet = [makeChange(["foo"], { a: 1 })];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(changes[0]);
    });

    it("should return empty array for empty input", () => {
      const result = compactChangeSet([]);
      expect(result).toHaveLength(0);
    });

    it("should return all changes when paths are siblings (no parent-child)", () => {
      const changes: ChangeSet = [
        makeChange(["a"], 1),
        makeChange(["b"], 2),
        makeChange(["c"], 3),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(3);
    });
  });

  describe("subsumption cases", () => {
    it("should subsume child when parent has matching content", () => {
      // Parent writes {a: 1} to 'foo', child writes 1 to 'foo.a'
      // Child write IS redundant because parent already sets 'a'
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["foo"]);
    });

    it("should NOT subsume child when parent sets different key (BUG TEST)", () => {
      // Parent writes {a: 1} to 'foo', child writes 99 to 'foo.b' (DIFFERENT key!)
      // Child write is NOT redundant - it sets a key not in parent!
      //
      // IMPORTANT: This test documents the EXPECTED behavior.
      // If this fails, it reveals the bug in compactChangeSet.
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }),
        makeChange(["foo", "b"], 99),
      ];
      const result = compactChangeSet(changes);

      // We EXPECT both changes to be kept because parent doesn't include 'b'
      // If this assertion fails with length 1, the bug exists.
      expect(result).toHaveLength(2);
      expect(result[0].location.path).toEqual(["foo"]);
      expect(result[1].location.path).toEqual(["foo", "b"]);
    });

    it("should subsume child when parent is deleted (undefined)", () => {
      // Deleting parent also deletes all children
      const changes: ChangeSet = [
        makeChange(["foo"], undefined),
        makeChange(["foo", "a"], 1),
        makeChange(["foo", "b", "c"], 2),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["foo"]);
      expect(result[0].value).toBeUndefined();
    });
  });

  describe("empty parent cases", () => {
    it("should NOT subsume when parent is empty object {}", () => {
      // Empty object doesn't include any children
      const changes: ChangeSet = [
        makeChange(["foo"], {}),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should NOT subsume when parent is empty array []", () => {
      // Empty array doesn't include any children
      const changes: ChangeSet = [
        makeChange(["items"], []),
        makeChange(["items", "0"], "first"),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should NOT subsume when parent is null", () => {
      const changes: ChangeSet = [
        makeChange(["foo"], null),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should NOT subsume when parent is primitive", () => {
      // Primitive can't have children
      const changes: ChangeSet = [
        makeChange(["foo"], 42),
        makeChange(["foo", "a"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });
  });

  describe("multi-document cases", () => {
    it("should not subsume across different documents", () => {
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }, "test:doc1"),
        makeChange(["foo", "a"], 1, "test:doc2"),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });

    it("should not subsume across different spaces", () => {
      const changes: ChangeSet = [
        makeChange(["foo"], { a: 1 }, "test:doc", "did:test:space1"),
        makeChange(["foo", "a"], 1, "test:doc", "did:test:space2"),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(2);
    });
  });

  describe("deep nesting", () => {
    it("should subsume grandchild when grandparent has content", () => {
      const changes: ChangeSet = [
        makeChange(["a"], { b: { c: 1 } }),
        makeChange(["a", "b"], { c: 1 }),
        makeChange(["a", "b", "c"], 1),
      ];
      const result = compactChangeSet(changes);
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["a"]);
    });

    it("should handle mixed nesting depths correctly", () => {
      // Parent sets {x: 1}, children set other keys at various depths
      const changes: ChangeSet = [
        makeChange(["root"], { x: 1 }),
        makeChange(["root", "y"], 2), // NOT in parent - should be kept
        makeChange(["root", "z", "deep"], 3), // NOT in parent - should be kept
      ];
      const result = compactChangeSet(changes);

      // With the fix, only children whose paths exist in parent are subsumed
      // Parent {x: 1} doesn't contain 'y' or 'z', so all 3 changes are kept
      expect(result).toHaveLength(3);
      expect(result[0].location.path).toEqual(["root"]);
      expect(result[1].location.path).toEqual(["root", "y"]);
      expect(result[2].location.path).toEqual(["root", "z", "deep"]);
    });
  });

  describe("array index paths", () => {
    it("should handle array index paths correctly", () => {
      const changes: ChangeSet = [
        makeChange(["items"], [1, 2, 3]),
        makeChange(["items", "0"], 1),
        makeChange(["items", "1"], 2),
      ];
      const result = compactChangeSet(changes);
      // Parent array has content, so children should be subsumed
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["items"]);
    });

    it("should handle array length changes", () => {
      const changes: ChangeSet = [
        makeChange(["items"], [1, 2]),
        makeChange(["items", "length"], 2),
      ];
      const result = compactChangeSet(changes);
      // Array has content, length change is subsumed
      expect(result).toHaveLength(1);
    });

    it("should NOT subsume child with leading-zero index like '01'", () => {
      // Parent writes array [1, 2], child writes to index "01"
      // "01" is not a valid array index (has leading zero), so the child
      // path does NOT exist in the parent and should NOT be subsumed.
      // Fixed by isArrayIndexPropertyName() which correctly rejects "01".
      const changes: ChangeSet = [
        makeChange(["items"], [1, 2]),
        makeChange(["items", "01"], 99),
      ];
      const result = compactChangeSet(changes);
      // Child should NOT be subsumed because "01" is not a valid array index
      expect(result).toHaveLength(2);
      expect(result[0].location.path).toEqual(["items"]);
      expect(result[1].location.path).toEqual(["items", "01"]);
    });
  });

  describe("order independence", () => {
    it("should work regardless of input order (child before parent)", () => {
      // Changes provided in child-first order
      const changes: ChangeSet = [
        makeChange(["foo", "a"], 1),
        makeChange(["foo"], { a: 1 }),
      ];
      const result = compactChangeSet(changes);
      // Should still compact to just the parent
      expect(result).toHaveLength(1);
      expect(result[0].location.path).toEqual(["foo"]);
    });
  });
});

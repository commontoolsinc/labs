import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Cell, CellLink, isCell, isStream } from "../src/cell.ts";
import type { JSONSchema } from "@commontools/builder";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema Support", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
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

  describe("Examples", () => {
    it("allows mapping of fields via interim cells", () => {
      const c = runtime.documentMap.getDoc(
        {
          id: 1,
          metadata: {
            createdAt: "2025-01-06",
            type: "user",
          },
          tags: ["a", "b"],
        },
        "allows mapping of fields via interim cells 1",
        space,
      );

      // This is what the system (or someone manually) would create to remap
      // data to match the desired schema
      const mappingCell = runtime.documentMap.getDoc(
        {
          // as-is
          id: { cell: c, path: ["id"] },
          // turn single value to set
          changes: [{ cell: c, path: ["metadata", "createdAt"] }],
          // rename field and uplift from nested element
          kind: { cell: c, path: ["metadata", "type"] },
          // turn set into a single value
          tag: { cell: c, path: ["tags", 0] },
        },
        "allows mapping of fields via interim cells 2",
        space,
      );

      // This schema is how the recipient specifies what they want
      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          changes: { type: "array", items: { type: "string" } },
          kind: { type: "string" },
          tag: { type: "string" },
        },
      } as const satisfies JSONSchema;

      // Let type inference work through the schema
      const result = mappingCell.asCell([], undefined, schema).get();

      expect(result).toEqual({
        id: 1,
        changes: ["2025-01-06"],
        kind: "user",
        tag: "a",
      });
    });

    it("should support nested sinks via asCell", async () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "string" },
          current: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            asCell: true,
          },
        },
        required: ["value", "current"],
      } as const satisfies JSONSchema;

      const c = runtime.documentMap.getDoc(
        {
          value: "root",
          current: runtime.documentMap.getDoc(
            { label: "first" },
            "should support nested sinks 1",
            space,
          ).asCell().getAsCellLink(),
        },
        "should support nested sinks 2",
        space,
      ).asCell([], undefined, schema);

      const rootValues: string[] = [];
      const currentValues: string[] = [];
      const currentByKeyValues: string[] = [];
      const currentByGetValues: string[] = [];

      // Nested traversal of data
      c.sink((value) => {
        rootValues.push(value.value);
        const cancel = value.current.sink((value) => {
          currentValues.push(value.label);
        });
        return () => {
          rootValues.push("cancelled");
          cancel();
        };
      });

      // Querying for a value tied to the currently selected sub-document
      c.key("current")
        .key("label")
        .sink((value) => {
          currentByKeyValues.push(value);
        });

      // .get() the currently selected cell
      c.key("current")
        .get()
        .sink((value) => {
          currentByGetValues.push(value.label);
        });

      await runtime.idle();

      // Find the currently selected cell and update it
      const first = c.key("current").get();
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqual({ label: "first" });
      first.set({ label: "first - update" });

      await runtime.idle();

      // Now change the currently selected cell
      const second = runtime.documentMap.getDoc(
        { label: "second" },
        "should support nested sinks 3",
        space,
      ).asCell();
      c.key("current").set(second);

      await runtime.idle();

      // Now change the first one again, should only change currentByGetValues
      first.set({ label: "first - updated again" });
      await runtime.idle();

      // Now change the second one, should change all but currentByGetValues
      second.set({ label: "second - update" });
      await runtime.idle();

      expect(currentByGetValues).toEqual([
        "first",
        "first - update",
        "first - updated again",
      ]);
      expect(currentByKeyValues).toEqual([
        "first",
        "first - update",
        "second",
        "second - update",
      ]);
      expect(currentValues).toEqual([
        "first",
        "first - update",
        "second",
        "second - update",
      ]);
      expect(rootValues).toEqual(["root", "cancelled", "root"]);
    });

    it("should support nested sinks via asCell with aliases", async () => {
      // We get this case in VDOM. There is an alias to a cell with a reference
      // to the actual data, and that reference is updated. So it's similar to
      // the previous example, but the updating happens behind an alias,
      // typically by another actor.

      const schema = {
        type: "object",
        properties: {
          value: { type: "string" },
          current: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            asCell: true,
          },
        },
        required: ["value", "current"],
      } as const satisfies JSONSchema;

      // Construct an alias that also has a path to the actual data
      const initialDoc = runtime.documentMap.getDoc(
        { foo: { label: "first" } },
        "should support nested sinks via asCell with aliases 1",
        space,
      );
      const initial = initialDoc.asCell();
      const linkDoc = runtime.documentMap.getDoc(
        initial.getAsCellLink(),
        "should support nested sinks via asCell with aliases 2",
        space,
      );
      const doc = runtime.documentMap.getDoc(
        {
          value: "root",
          current: { $alias: { cell: linkDoc, path: ["foo"] } },
        },
        "should support nested sinks via asCell with aliases 3",
        space,
      );
      const root = doc.asCell([], undefined, schema);

      const rootValues: any[] = [];
      const currentValues: any[] = [];
      const currentByKeyValues: any[] = [];
      const currentByGetValues: any[] = [];

      // Nested traversal of data
      root.sink((value) => {
        rootValues.push(value.value);
        const cancel = value.current.sink((value: { label: string }) => {
          currentValues.push(value.label);
        });
        return () => {
          rootValues.push("cancelled");
          cancel();
        };
      });

      // Querying for a value tied to the currently selected sub-document
      const current = root.key("current").key("label");
      current.sink((value: string) => {
        currentByKeyValues.push(value);
      });

      // Make sure the schema is correct and it is still anchored at the root
      expect(current.schema).toEqual({ type: "string" });
      expect(JSON.parse(JSON.stringify(current.getAsCellLink()))).toEqual({
        cell: doc.toJSON(),
        path: ["current", "label"],
        space,
        schema: current.schema,
        rootSchema: current.rootSchema,
      });

      // .get() the currently selected cell. This should not change when
      // the currently selected cell changes!
      root
        .key("current")
        .get()
        .sink((value: { label: string }) => {
          currentByGetValues.push(value.label);
        });

      await runtime.idle();

      // Find the currently selected cell and read it
      const log = { reads: [], writes: [] };
      const first = root.key("current").withLog(log).get();
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqual({ label: "first" });
      const { asCell: _ignore, ...omitSchema } = schema.properties.current;
      expect(JSON.parse(JSON.stringify(first.getAsCellLink()))).toEqual({
        cell: initialDoc.toJSON(),
        path: ["foo"],
        space,
        schema: omitSchema,
        rootSchema: schema,
      });
      expect(log.reads.length).toEqual(4);
      expect(
        log.reads.map((r: CellLink) => ({
          cell: r.cell.toJSON(),
          path: r.path,
        })),
      ).toEqual([
        { cell: doc.toJSON(), path: ["current"] },
        { cell: linkDoc.toJSON(), path: [] },
        { cell: initialDoc.toJSON(), path: ["foo"] },
        { cell: initialDoc.toJSON(), path: ["foo", "label"] },
      ]);

      // Then update it
      initial.set({ foo: { label: "first - update" } });
      await runtime.idle();
      expect(first.get()).toEqual({ label: "first - update" });

      // Now change the currently selected cell behind the alias. This should
      // trigger a change on the root cell, since this is the first doc after
      // the aliases.
      const second = runtime.documentMap.getDoc(
        { foo: { label: "second" } },
        "should support nested sinks via asCell with aliases 4",
        space,
      ).asCell();
      linkDoc.send(second.getAsCellLink());

      await runtime.idle();

      expect(rootValues).toEqual(["root", "cancelled", "root"]);

      // Change unrelated value should update root, but not the other cells
      root.key("value").set("root - updated");
      await runtime.idle();
      expect(rootValues).toEqual([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
      ]);

      // Now change the first one again, should only change currentByGetValues
      initial.set({ foo: { label: "first - updated again" } });
      await runtime.idle();

      // Now change the second one, should change all but currentByGetValues
      second.set({ foo: { label: "second - update" } });
      await runtime.idle();

      expect(rootValues).toEqual([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
      ]);

      // Now change the alias. This should also be seen by the root cell. It
      // will not be seen by the .get()s earlier, since they anchored on the
      // link, not the alias ahead of it. That's intentional.
      const third = runtime.documentMap.getDoc(
        { label: "third" },
        "should support nested sinks via asCell with aliases 5",
        space,
      ).asCell();
      doc.setAtPath(["current"], {
        $alias: { cell: third.getDoc(), path: [] },
      });

      await runtime.idle();

      // Now change the first one again, should only change currentByGetValues
      initial.set({ foo: { label: "first - updated yet again" } });
      second.set({ foo: { label: "second - updated again" } });
      third.set({ label: "third - updated" });
      await runtime.idle();

      expect(currentByGetValues).toEqual([
        "first",
        "first - update",
        "first - updated again",
        "first - updated yet again",
      ]);
      expect(currentByKeyValues).toEqual([
        "first",
        "first - update",
        "second",
        "second - update",
        "third",
        "third - updated",
      ]);
      expect(currentValues).toEqual([
        "first",
        "first - update",
        "second", // That was changing `value` on root
        "second",
        "second - update",
        "third",
        "third - updated",
      ]);
      expect(rootValues).toEqual([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
        "cancelled",
        "root - updated",
      ]);
    });
  });

  describe("Basic Types", () => {
    it("should handle primitive types", () => {
      const c = runtime.documentMap.getDoc(
        {
          str: "hello",
          num: 42,
          bool: true,
        },
        "should handle primitive types 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          str: { type: "string" },
          num: { type: "number" },
          bool: { type: "boolean" },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.str).toBe("hello");
      expect(value.num).toBe(42);
      expect(value.bool).toBe(true);
    });

    it("should handle nested objects", () => {
      const c = runtime.documentMap.getDoc(
        {
          user: {
            name: "John",
            settings: {
              theme: "dark",
            },
          },
        },
        "should handle nested objects 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                asCell: true,
              },
            },
            required: ["name", "settings"],
          },
        },
        required: ["user"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.user.name).toBe("John");
      expect(isCell(value.user.settings)).toBe(true);
    });

    it("should handle arrays", () => {
      const c = runtime.documentMap.getDoc(
        {
          items: [1, 2, 3],
        },
        "should handle arrays 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "number" },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.items).toEqual([1, 2, 3]);
    });
  });

  describe("References", () => {
    it("should return a Cell for reference properties", () => {
      const c = runtime.documentMap.getDoc(
        {
          id: 1,
          metadata: {
            createdAt: "2025-01-06",
            type: "user",
          },
        },
        "should return a Cell for reference properties 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          metadata: {
            type: "object",
            asCell: true,
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.id).toBe(1);
      expect(isCell(value.metadata)).toBe(true);

      // The metadata cell should behave like a normal cell
      const metadataValue = value.metadata?.get();
      expect(metadataValue?.createdAt).toBe("2025-01-06");
      expect(metadataValue?.type).toBe("user");
    });

    it("Should support a reference at the root", () => {
      const c = runtime.documentMap.getDoc(
        {
          id: 1,
          nested: { id: 2 },
        },
        "Should support a reference at the root 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          nested: { $ref: "#", asCell: true },
        },
        asCell: true,
        required: ["id", "nested"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().id).toBe(1);
      expect(isCell(value.get().nested)).toBe(true);
      expect(value.get().nested.get().id).toBe(2);
    });
  });

  describe("Schema References", () => {
    it("should handle self-references with $ref: '#'", () => {
      const c = runtime.documentMap.getDoc(
        {
          name: "root",
          children: [
            { name: "child1", children: [] },
            { name: "child2", children: [] },
          ],
        },
        "should handle self-references with $ref 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          children: {
            type: "array",
            items: { $ref: "#" },
          },
        },
        required: ["name", "children"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[1].name).toBe("child2");
    });
  });

  describe("Key Navigation", () => {
    it("should preserve schema when using key()", () => {
      const c = runtime.documentMap.getDoc(
        {
          user: {
            profile: {
              name: "John",
              metadata: { id: 123 },
            },
          },
        },
        "should preserve schema when using key 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  metadata: {
                    type: "object",
                    asCell: true,
                  },
                },
                required: ["name", "metadata"],
              },
            },
            required: ["profile"],
          },
        },
        required: ["user"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const userCell = cell.key("user");
      const profileCell = userCell.key("profile");
      const value = profileCell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.metadata)).toBe(true);
    });
  });

  describe("AnyOf Support", () => {
    it("should select the correct candidate for primitive types (number)", () => {
      const c = runtime.documentMap.getDoc(
        { value: 42 },
        "should select the correct candidate for primitive types (number) 1",
        space,
      );
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBe(42);
    });

    it("should select the correct candidate for primitive types (string)", () => {
      const c = runtime.documentMap.getDoc(
        { value: "hello" },
        "should select the correct candidate for primitive types (string) 1",
        space,
      );
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBe("hello");
    });

    it("should merge object candidates in anyOf", () => {
      const c = runtime.documentMap.getDoc(
        { item: { a: 100, b: "merged" } },
        "should merge object candidates in anyOf 1",
        space,
      );
      const schema = {
        type: "object",
        properties: {
          item: {
            anyOf: [
              {
                type: "object",
                properties: { a: { type: "number" } },
                required: ["a"],
              },
              {
                type: "object",
                properties: { b: { type: "string" } },
                required: ["b"],
              },
            ],
          },
        },
        required: ["item"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect((result.item as { a: number }).a).toBe(100);
      expect((result.item as { b: string }).b).toBe("merged");
    });

    it("should return undefined if no anyOf candidate matches for primitive types", () => {
      const c = runtime.documentMap.getDoc(
        { value: true },
        "should return undefined if no anyOf candidate matches 1",
        space,
      );
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should return undefined when value is an object but no anyOf candidate is an object", () => {
      const c = runtime.documentMap.getDoc(
        { value: { a: 1 } },
        "should return undefined when value is an object 1",
        space,
      );
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should handle anyOf in array items", () => {
      const c = runtime.documentMap.getDoc(
        { arr: [42, space, true] },
        "should handle anyOf in array items 1",
        space,
      );
      const schema = {
        type: "object",
        properties: {
          arr: {
            type: "array",
            items: {
              anyOf: [{ type: "number" }, { type: "string" }],
            },
          },
        },
        required: ["arr"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const result = cell.get();
      expect(result.arr[0]).toBe(42);
      expect(result.arr[1]).toBe(space);
      expect(result.arr[2]).toBeUndefined();
    });

    it("should select the correct candidate when mixing object and array candidates", () => {
      // Case 1: When the value is an object, the object candidate should be used.
      const cObject = runtime.documentMap.getDoc(
        { mixed: { foo: "bar" } },
        "should select the correct candidate when mixing 1",
        space,
      );
      const schemaObject = {
        type: "object",
        properties: {
          mixed: {
            anyOf: [
              {
                type: "object",
                properties: { foo: { type: "string" } },
                required: ["foo"],
              },
              // Array candidate; this should be ignored for object inputs.
              { type: "array", items: { type: "string" } },
            ],
          },
        },
        required: ["mixed"],
      } as const satisfies JSONSchema;

      const cellObject = cObject.asCell([], undefined, schemaObject);
      const resultObject = cellObject.get();
      // Since the input is an object, the object candidate is selected.
      // TS doesn't infer `foo as string` when mixing objects and arrays, so have to cast.
      expect((resultObject.mixed as { foo: string }).foo).toBe("bar");

      // Case 2: When the value is an array, the array candidate should be used.
      const cArray = runtime.documentMap.getDoc(
        { mixed: ["bar", "baz"] },
        "should select the correct candidate when mixing 2",
        space,
      );
      const schemaArray = {
        type: "object",
        properties: {
          mixed: {
            anyOf: [
              // Object candidate; this should be ignored for array inputs.
              { type: "object", properties: { foo: { type: "string" } } },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
      } as const satisfies JSONSchema;

      const cellArray = cArray.asCell([], undefined, schemaArray);
      const resultArray = cellArray.get();
      // Verify that the array candidate is chosen and returns the intended array.
      expect(resultArray).toEqual({ mixed: ["bar", "baz"] });
      expect(Array.isArray(resultArray.mixed)).toBe(true);
      expect(resultArray.mixed).toEqual(["bar", "baz"]);
    });

    describe("Array anyOf Support", () => {
      it("should handle multiple array type options in anyOf", () => {
        const c = runtime.documentMap.getDoc(
          { data: [1, 2, 3] },
          "should handle multiple array type options 1",
          space,
        );
        const schema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "number" } },
                { type: "array", items: { type: "string" } },
              ],
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        expect(result.data).toEqual([1, 2, 3]);
      });

      it("should merge item schemas when multiple array options exist", () => {
        const c = runtime.documentMap.getDoc(
          { data: ["hello", 42, true] },
          "should merge item schemas when multiple array options 1",
          space,
        );
        const schema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "string" } },
                { type: "array", items: { type: "number" } },
              ],
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        // Should keep string and number values, drop boolean
        expect(result.data).toEqual(["hello", 42, undefined]);
      });

      it("should handle nested anyOf in array items", () => {
        const c = runtime.documentMap.getDoc(
          {
            data: [
              { type: "text", value: "hello" },
              { type: "number", value: 42 },
            ],
          },
          "should handle nested anyOf in array items 1",
          space,
        );
        const schema = {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      value: { type: "string" },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      value: { type: "number" },
                    },
                  },
                ],
              },
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        expect(result.data).toEqual([
          { type: "text", value: "hello" },
          { type: "number", value: 42 },
        ]);
      });

      it("should return empty array when no array options match", () => {
        const c = runtime.documentMap.getDoc(
          { data: { key: "value" } },
          "should return empty array when no array options match 1",
          space,
        );
        const schema = {
          type: "object",
          properties: {
            data: {
              anyOf: [
                { type: "array", items: { type: "string" } },
                { type: "array", items: { type: "number" } },
              ],
            },
          },
        } as const satisfies JSONSchema;

        const cell = c.asCell([], undefined, schema);
        const result = cell.get();
        expect(result.data).toBeUndefined();
      });

      it("should work for the vdom schema with $ref", () => {
        const plain = runtime.documentMap.getDoc(
          {
            type: "vnode",
            name: "div",
            props: { style: { color: "red" } },
            children: [
              { type: "text", value: "single" },
              [
                { type: "text", value: "hello" },
                { type: "text", value: "world" },
              ],
              "or just text",
            ],
          },
          "should work for the vdom schema with $ref 1",
          space,
        );

        const withLinks = runtime.documentMap.getDoc(
          {
            type: "vnode",
            name: "div",
            props: {
              style: {
                cell: runtime.documentMap.getDoc(
                  { color: "red" },
                  "should work for the vdom schema with $ref 2",
                  space,
                ),
                path: [],
              },
            },
            children: [
              { type: "text", value: "single" },
              {
                cell: runtime.documentMap.getDoc(
                  [
                    { type: "text", value: "hello" },
                    {
                      cell: runtime.documentMap.getDoc(
                        { type: "text", value: "world" },
                        "should work for the vdom schema with $ref 4",
                        space,
                      ),
                      path: [],
                    },
                  ],
                  "should work for the vdom schema with $ref 5",
                  space,
                ),
                path: [],
              },
              "or just text",
            ],
          },
          "should work for the vdom schema with $ref 3",
          space,
        );

        const vdomSchema = {
          type: "object",
          properties: {
            type: { type: "string" },
            name: { type: "string" },
            value: { type: "string" },
            props: {
              type: "object",
              additionalProperties: { asCell: true },
            },
            children: {
              type: "array",
              items: {
                anyOf: [
                  { $ref: "#", asCell: true },
                  { type: "string", asCell: true },
                  { type: "number", asCell: true },
                  { type: "boolean", asCell: true },
                  { type: "array", items: { $ref: "#", asCell: true } },
                ],
              },
              asCell: true,
            },
          },
          required: ["type", "name", "value", "props", "children"],
        } as const satisfies JSONSchema;

        for (const doc of [plain, withLinks]) {
          const cell = doc.asCell([], undefined, vdomSchema);
          const result = cell.get();
          expect(result.type).toBe("vnode");
          expect(result.name).toBe("div");
          expect(isCell(result.props)).toBe(false);
          expect(isCell(result.props.style)).toBe(true);
          expect(result.props.style.get().color).toBe("red");
          expect(isCell(result.children)).toBe(true);
          const children = result.children.get();
          expect(children.length).toBe(3);
          expect(isCell(children[0])).toBe(true);
          expect((children[0] as Cell<any>).get().value).toBe("single");
          expect(isCell(children[1])).toBe(false);
          expect(Array.isArray(children[1])).toBe(true);
          const child1 = children[1] as unknown as Cell<any>[];
          expect(isCell(child1[0])).toBe(true);
          expect(child1[0].get().value).toBe("hello");
          expect(
            isCell(child1[1]),
          ).toBe(true);
          expect(child1[1].get().value).toBe("world");
          expect(isCell(children[2])).toBe(true);
          expect((children[2] as Cell<any>).get()).toBe("or just text");
        }
      });
    });
  });

  describe("Default Values", () => {
    it("should use the default value when property is undefined", () => {
      const c = runtime.documentMap.getDoc(
        {
          name: "John",
          // age is not defined
        },
        "should use the default value when property is undefined 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", default: 30 },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(value.age).toBe(30);
    });

    it("should use the default value with asCell for objects", () => {
      const c = runtime.documentMap.getDoc(
        {
          name: "John",
          // profile is not defined
        },
        "should use the default value with asCell for objects 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          profile: {
            type: "object",
            properties: {
              bio: { type: "string" },
              avatar: { type: "string" },
            },
            default: { bio: "Default bio", avatar: "default.png" },
            asCell: true,
          },
        },
        required: ["name", "profile"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.profile)).toBe(true);
      expect(value.profile.get()).toEqual({
        bio: "Default bio",
        avatar: "default.png",
      });

      // Verify the profile cell can be updated
      value.profile.set({ bio: "Updated bio", avatar: "new.png" });
      expect(value.profile.get()).toEqual({
        bio: "Updated bio",
        avatar: "new.png",
      });
    });

    it("should use the default value with asCell for arrays", () => {
      const c = runtime.documentMap.getDoc(
        {
          name: "John",
          // tags is not defined
        },
        "should use the default value with asCell for arrays 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
            default: ["default", "tags"],
            asCell: true,
          },
        },
        required: ["name", "tags"],
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.tags)).toBe(true);
      expect(value.tags.get()).toEqual(["default", "tags"]);

      // Verify the tags cell can be updated
      value.tags.set(["updated", "tags", "list"]);
      expect(value.tags.get()).toEqual(["updated", "tags", "list"]);
    });

    it("should handle nested default values with asCell", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              settings: {
                type: "object",
                properties: {
                  theme: {
                    type: "object",
                    properties: {
                      mode: { type: "string" },
                      color: { type: "string" },
                    },
                    default: { mode: "dark", color: "blue" },
                    asCell: true,
                  },
                  notifications: { type: "boolean", default: true },
                },
                default: {
                  theme: { mode: "light", color: "red" },
                  notifications: true,
                },
                asCell: true,
              },
            },
            required: ["name", "settings"],
          },
        },
        required: ["user"],
      } as const satisfies JSONSchema;

      const c = runtime.documentMap.getDoc(
        {
          user: {
            name: "John",
            // settings is not defined
          },
        },
        "should use the default value with nested schema 1",
        space,
      );

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.user.name).toBe("John");
      expect(isCell(value.user.settings)).toBe(true);

      const settings = value.user.settings.get();
      expect(settings.notifications).toBe(true);
      expect(isCell(settings.theme)).toBe(true);
      expect(isCell(settings.theme.get())).toBe(false);
      expect(settings.theme.get()).toEqual({ mode: "light", color: "red" });

      const c2 = runtime.documentMap.getDoc(
        {
          user: {
            name: "John",
            // settings is set, but theme is not
            settings: { notifications: false },
          },
        },
        "should use the default value with nested schema 2",
        space,
      );

      const cell2 = c2.asCell([], undefined, schema);
      const value2 = cell2.get();

      expect(value2.user.name).toBe("John");
      expect(isCell(value2.user.settings)).toBe(true);

      const settings2 = value2.user.settings.get();
      expect(settings2.notifications).toBe(false);
      expect(isCell(settings2.theme)).toBe(true);
      expect(settings2.theme.get()).toEqual({ mode: "dark", color: "blue" });
    });

    it("should handle default values with asCell in arrays", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                title: { type: "string", default: "Default Title" },
                metadata: {
                  type: "object",
                  properties: {
                    createdAt: { type: "string" },
                  },
                  asCell: true,
                },
              },
            },
            default: [
              {
                id: 1,
                title: "First Item",
                metadata: { createdAt: "2023-01-01" },
              },
              {
                id: 2,
                metadata: { createdAt: "2023-01-02" },
              },
            ],
          },
        },
        default: {},
      } as const satisfies JSONSchema;

      const c = runtime.documentMap.getDoc(
        {
          items: [
            { id: 1, title: "First Item" },
            // Second item has missing properties
            { id: 2 },
          ],
        },
        "should use the default value for array items 1",
        space,
      );
      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.items?.[0].title).toBe("First Item");
      expect(value.items?.[1].title).toBe("Default Title");

      expect(isCell(value.items?.[0].metadata)).toBe(true);
      expect(isCell(value.items?.[1].metadata)).toBe(true);

      const c2 = runtime.documentMap.getDoc(
        undefined,
        "should use the default value for array items 2",
        space,
      );
      const cell2 = c2.asCell([], undefined, schema);
      const value2 = cell2.get();

      expect(value2.items?.length).toBe(2);
      expect(value2.items?.[0].title).toBe("First Item");
      expect(value2.items?.[1].title).toBe("Default Title");

      expect(isCell(value2.items?.[0].metadata)).toBe(true);
      expect(isCell(value2.items?.[1].metadata)).toBe(true);

      expect(value2.items?.[0].metadata?.get()).toEqual({
        createdAt: "2023-01-01",
      });
      expect(value2.items?.[1].metadata?.get()).toEqual({
        createdAt: "2023-01-02",
      });
    });

    it("should handle default values with additionalProperties", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              knownProp: { type: "string" },
            },
            additionalProperties: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
                value: { type: "string" },
              },
              default: { enabled: true, value: "default" },
              asCell: true,
            },
            default: {
              knownProp: "default",
              feature1: { enabled: true, value: "feature1" },
              feature2: { enabled: false, value: "feature2" },
            },
          },
        },
        required: ["config"],
      } as const satisfies JSONSchema;

      const c = runtime.documentMap.getDoc(
        undefined,
        "should handle default values with additionalProperties 1",
        space,
      );
      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.config.knownProp).toBe("default");

      // These come from the default and should be processed as cells because of asCell in additionalProperties
      expect(isCell(value.config.feature1)).toBe(true);
      expect(isCell(value.config.feature2)).toBe(true);

      expect(value.config.feature1?.get()).toEqual({
        enabled: true,
        value: "feature1",
      });
      expect(value.config.feature2?.get()).toEqual({
        enabled: false,
        value: "feature2",
      });
    });

    it("should handle default at the root level with asCell", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          settings: {
            type: "object",
            properties: {
              theme: { type: "string" },
            },
          },
        },
        default: {
          name: "Default User",
          settings: { theme: "light" },
        },
        asCell: true,
      } as const satisfies JSONSchema;

      const c = runtime.documentMap.getDoc(
        undefined,
        "should use the default value at the root level 1",
        space,
      );
      const cell = c.asCell([], undefined, schema);

      // The whole document should be a cell containing the default
      expect(isCell(cell)).toBe(true);
      const cellValue = cell.get();
      expect(isCell(cellValue)).toBe(true);
      const value = cellValue.get();
      expect(value).toEqual({
        name: "Default User",
        settings: { theme: "light" },
      });

      // Verify it can be updated
      cell.set(
        runtime.getImmutableCell(space, {
          name: "Updated User",
          settings: { theme: "dark" },
        }),
      );
      expect(cell.get().get()).toEqual({
        name: "Updated User",
        settings: { theme: "dark" },
      });
    });

    it("should make immutable cells if they provide the default value", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", default: "Default Name", asCell: true },
        },
        default: {},
      } as const satisfies JSONSchema;

      const c = runtime.documentMap.getDoc(
        undefined,
        "should make immutable cells if they provide the default value 1",
        space,
      );
      const cell = c.asCell([], undefined, schema);
      const value = cell.get();
      expect(isCell(value.name)).toBe(true);
      expect(value?.name?.get()).toBe("Default Name");

      cell.set(
        runtime.getImmutableCell(space, { name: "Updated Name" }),
      );

      // Expect the cell to be immutable
      expect(value?.name?.get()).toBe("Default Name");
    });

    it("should make mutable cells if parent provides the default value", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", default: "Default Name", asCell: true },
        },
        default: { name: "First default name" },
      } as const satisfies JSONSchema;

      const c = runtime.documentMap.getDoc(
        undefined,
        "should make mutable cells if parent provides the default value 1",
        space,
      );
      const cell = c.asCell([], undefined, schema);
      const value = cell.get();
      expect(isCell(value.name)).toBe(true);
      expect(value.name.get()).toBe("First default name");

      cell.set({ name: runtime.getImmutableCell(space, "Updated Name") });

      // Expect the cell to be immutable
      expect(value.name.get()).toBe("Updated Name");
    });
  });

  describe("Stream Support", () => {
    it("should create a stream for properties marked with asStream", () => {
      const c = runtime.documentMap.getDoc(
        {
          name: "Test Doc",
          events: { $stream: true },
        },
        "should create a stream for properties marked with asStream 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          events: {
            type: "object",
            asStream: true,
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.name).toBe("Test Doc");
      expect(isStream(value.events)).toBe(true);

      // Verify it's a stream, i.e. no get functio
      expect((value as any).events.get).toBe(undefined);
    });

    it("should handle nested streams in objects", () => {
      const c = runtime.documentMap.getDoc(
        {
          user: {
            profile: {
              name: "John",
              notifications: { $stream: true },
            },
          },
        },
        "should handle nested streams in objects 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  notifications: {
                    type: "object",
                    asStream: true,
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value?.user?.profile?.name).toBe("John");
      expect(isStream(value?.user?.profile?.notifications)).toBe(true);
    });

    it("should not create a stream when property is missing", () => {
      const c = runtime.documentMap.getDoc(
        {
          name: "Test Doc",
          // Missing events property
        },
        "should not create a stream when property is missing 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          events: {
            type: "object",
            asStream: true,
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(value.name).toBe("Test Doc");
      expect(isStream(value.events)).toBe(false);
    });

    it("should behave correctly when both asCell and asStream are in the schema", () => {
      const c = runtime.documentMap.getDoc(
        {
          cellData: { value: 42 },
          streamData: { $stream: true },
        },
        "should behave correctly when both asCell and asStream are in the schema 1",
        space,
      );

      const schema = {
        type: "object",
        properties: {
          cellData: {
            type: "object",
            asCell: true,
          },
          streamData: {
            type: "object",
            asStream: true,
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asCell([], undefined, schema);
      const value = cell.get();

      expect(isCell(value.cellData)).toBe(true);
      expect(value?.cellData?.get()?.value).toBe(42);

      expect(isStream(value.streamData)).toBe(true);
    });
  });

  describe("Running Promise", () => {
    it("should allow setting a promise when none is running", async () => {
      await runtime.idle();

      const { promise, resolve } = Promise.withResolvers();
      runtime.scheduler.runningPromise = promise;
      expect(runtime.scheduler.runningPromise).toBeDefined();
      resolve(space);
      await promise;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });

    it("should throw when trying to set a promise while one is running", async () => {
      await runtime.idle();

      const { promise: promise1, resolve: resolve1 } = Promise.withResolvers();
      runtime.scheduler.runningPromise = promise1;
      expect(runtime.scheduler.runningPromise).toBeDefined();

      const { promise: promise2, resolve: resolve2 } = Promise.withResolvers();
      expect(() => {
        runtime.scheduler.runningPromise = promise2;
      }).toThrow("Cannot set running while another promise is in progress");

      resolve1(space);
      await promise1;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });

    it("should clear the promise after it rejects", async () => {
      await runtime.idle();

      const { promise, reject } = Promise.withResolvers();
      runtime.scheduler.runningPromise = promise.catch(() => {});

      // Now reject after the handler is in place
      reject(new Error("test error"));

      // Wait for both the rejection to be handled and the promise to be cleared
      await runtime.scheduler.runningPromise;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });

    it("should allow setting undefined when no promise is running", async () => {
      await runtime.idle();

      runtime.scheduler.runningPromise = undefined;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });
  });
});

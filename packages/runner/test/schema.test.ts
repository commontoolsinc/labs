import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { type Cell, isCell, isStream } from "../src/cell.ts";
import { SigilLink } from "../src/sigil-types.ts";
import { ID, type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { toURI } from "../src/uri-utils.ts";
import { parseLink, sanitizeSchemaForLinks } from "../src/link-utils.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { sortAndCompactPaths } from "../src/reactive-dependencies.ts";
import { toCell } from "../src/back-to-cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema Support", () => {
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
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Examples", () => {
    it("allows mapping of fields via interim cells", () => {
      const c = runtime.getCell<{
        id: number;
        metadata: {
          createdAt: string;
          type: string;
        };
        tags: string[];
      }>(
        space,
        "allows mapping of fields via interim cells 1",
        undefined,
        tx,
      );
      c.set({
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
        tags: ["a", "b"],
      });

      // This is what the system (or someone manually) would create to remap
      // data to match the desired schema
      const mappingCell = runtime.getCell<{
        id: SigilLink;
        changes: SigilLink[];
        kind: SigilLink;
        tag: SigilLink;
      }>(
        space,
        "allows mapping of fields via interim cells 2",
        undefined,
        tx,
      );
      mappingCell.setRaw({
        // as-is
        id: c.key("id").getAsLink(),
        // turn single value to set
        changes: [c.key("metadata").key("createdAt").getAsLink()],
        // rename field and uplift from nested element
        kind: c.key("metadata").key("type").getAsLink(),
        // turn set into a single value
        tag: c.key("tags").key(0).getAsLink(),
      });

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
      const result = mappingCell.asSchema(schema).get();

      expect(result).toEqualIgnoringSymbols({
        id: 1,
        changes: ["2025-01-06"],
        kind: "user",
        tag: "a",
      });
    });

    it("should support nested sinks via asCell", async () => {
      const innerCell = runtime.getCell<{ label: string }>(
        space,
        "should support nested sinks 1",
      );
      innerCell.withTx(tx).set({ label: "first" });

      const cell = runtime.getCell(
        space,
        "should support nested sinks 2",
        {
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
        } as const satisfies JSONSchema,
        tx,
      );
      cell.withTx(tx).setRaw({
        value: "root",
        current: innerCell.getAsLink(),
      });

      tx.commit();
      tx = runtime.edit();

      const rootValues: string[] = [];
      const currentValues: string[] = [];
      const currentByKeyValues: string[] = [];
      const currentByGetValues: string[] = [];

      // Nested traversal of data
      const cancel = cell.sink((value) => {
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
      cell.key("current")
        .key("label")
        .sink((value) => {
          currentByKeyValues.push(value);
        });

      // .get() the currently selected cell
      cell.key("current")
        .get()
        .sink((value) => {
          currentByGetValues.push(value.label);
        });

      await runtime.idle();

      // Find the currently selected cell and update it
      const first = cell.key("current").get();
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqualIgnoringSymbols({ label: "first" });
      first.withTx(tx).set({ label: "first - update" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the currently selected cell
      const second = runtime.getCell(
        space,
        "should support nested sinks 3",
        {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        } as const satisfies JSONSchema,
        tx,
      );
      second.withTx(tx).set({ label: "second" });
      cell.withTx(tx).key("current").set(second);

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the first one again, should only change currentByGetValues
      first.withTx(tx).set({ label: "first - updated again" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the second one, should change all but currentByGetValues
      second.withTx(tx).set({ label: "second - update" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(currentByGetValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "first - updated again",
      ]);
      expect(currentByKeyValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second",
        "second - update",
      ]);
      expect(currentValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second",
        "second - update",
      ]);
      expect(rootValues).toEqualIgnoringSymbols([
        "root",
        "cancelled",
        "root",
      ]);

      cancel();

      expect(rootValues).toEqualIgnoringSymbols([
        "root",
        "cancelled",
        "root",
        "cancelled",
      ]);
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
      const initial = runtime.getCell<{ foo: { label: string } }>(
        space,
        "should support nested sinks via asCell with aliases 1",
      );
      initial.withTx(tx).set({ foo: { label: "first" } });
      const initialEntityId = initial.entityId!;

      const linkCell = runtime.getCell<any>(
        space,
        "should support nested sinks via asCell with aliases 2",
      );
      linkCell.withTx(tx).setRaw(initial.getAsLink());
      const linkEntityId = linkCell.entityId!;

      const docCell = runtime.getCell<{
        value: string;
        current: any;
      }>(
        space,
        "should support nested sinks via asCell with aliases 3",
      );
      docCell.withTx(tx).setRaw({
        value: "root",
        current: linkCell.key("foo").getAsWriteRedirectLink(),
      });

      tx.commit();
      tx = runtime.edit();

      const root = docCell.asSchema(schema);

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
      expect(parseLink(current.getAsLink({ includeSchema: true }))).toEqual({
        id: toURI(docCell.entityId!),
        path: ["current", "label"],
        space,
        schema: current.schema,
        rootSchema: sanitizeSchemaForLinks(current.rootSchema),
        type: "application/json",
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
      const first = root.key("current").withTx(tx).get();
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqualIgnoringSymbols({ label: "first" });
      const { asCell: _ignore, ...omitSchema } = schema.properties.current;
      expect(parseLink(first.getAsLink({ includeSchema: true }))).toEqual({
        id: toURI(initialEntityId),
        path: ["foo"],
        space,
        type: "application/json",
        schema: omitSchema,
        rootSchema: sanitizeSchemaForLinks(schema),
      });
      const log = txToReactivityLog(tx);
      const reads = sortAndCompactPaths(log.reads);
      expect(reads).toContainEqual({
        space,
        id: toURI(linkEntityId),
        path: [],
        type: "application/json",
      });
      expect(reads).toContainEqual({
        space,
        id: toURI(docCell.entityId!),
        path: ["current"],
        type: "application/json",
      });
      expect(reads).toContainEqual({
        space,
        id: toURI(initialEntityId),
        path: ["foo"],
        type: "application/json",
      });

      // Then update it
      initial.withTx(tx).set({ foo: { label: "first - update" } });
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      expect(first.get()).toEqualIgnoringSymbols({
        label: "first - update",
      });

      // Now change the currently selected cell behind the alias. This should
      // trigger a change on the root cell, since this is the first doc after
      // the aliases.
      const second = runtime.getCell<{ foo: { label: string } }>(
        space,
        "should support nested sinks via asCell with aliases 4",
      );
      second.withTx(tx).set({ foo: { label: "second" } });
      linkCell.withTx(tx).setRaw(second.getAsLink());

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(rootValues).toEqual([
        "root",
        "cancelled",
        "root",
      ]);

      // Change unrelated value should update root, but not the other cells
      root.withTx(tx).key("value").set("root - updated");
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(rootValues).toEqual([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
      ]);

      // Now change the first one again, should only change currentByGetValues
      initial.withTx(tx).set({ foo: { label: "first - updated again" } });
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the second one, should change all but currentByGetValues
      second.withTx(tx).set({ foo: { label: "second - update" } });
      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(rootValues).toEqualIgnoringSymbols([
        "root",
        "cancelled",
        "root",
        "cancelled",
        "root - updated",
      ]);

      // Now change the alias. This should also be seen by the root cell. It
      // will not be seen by the .get()s earlier, since they anchored on the
      // link, not the alias ahead of it. That's intentional.
      const third = runtime.getCell<{ label: string }>(
        space,
        "should support nested sinks via asCell with aliases 5",
      );
      third.withTx(tx).set({ label: "third" });
      docCell.withTx(tx).key("current").setRaw(third.getAsWriteRedirectLink());

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      // Now change the first one again, should only change currentByGetValues
      initial.withTx(tx).set({ foo: { label: "first - updated yet again" } });
      second.withTx(tx).set({ foo: { label: "second - updated again" } });
      third.withTx(tx).set({ label: "third - updated" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();

      expect(currentByGetValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "first - updated again",
        "first - updated yet again",
      ]);
      expect(currentByKeyValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second",
        "second - update",
        "third",
        "third - updated",
      ]);
      expect(currentValues).toEqualIgnoringSymbols([
        "first",
        "first - update",
        "second", // That was changing `value` on root
        "second",
        "second - update",
        "third",
        "third - updated",
      ]);
      expect(rootValues).toEqualIgnoringSymbols([
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
      const c = runtime.getCell<{
        str: string;
        num: number;
        bool: boolean;
      }>(
        space,
        "should handle primitive types 1",
        undefined,
        tx,
      );
      c.set({
        str: "hello",
        num: 42,
        bool: true,
      });

      const schema = {
        type: "object",
        properties: {
          str: { type: "string" },
          num: { type: "number" },
          bool: { type: "boolean" },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.str).toBe("hello");
      expect(value.num).toBe(42);
      expect(value.bool).toBe(true);
    });

    it("should handle nested objects", () => {
      const c = runtime.getCell<{
        user: {
          name: string;
          settings: {
            theme: string;
          };
        };
      }>(
        space,
        "should handle nested objects 1",
        undefined,
        tx,
      );
      c.set({
        user: {
          name: "John",
          settings: {
            theme: "dark",
          },
        },
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.user.name).toBe("John");
      expect(isCell(value.user.settings)).toBe(true);
    });

    it("should handle arrays", () => {
      const c = runtime.getCell<{
        items: number[];
      }>(
        space,
        "should handle arrays 1",
        undefined,
        tx,
      );
      c.set({
        items: [1, 2, 3],
      });

      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "number" },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.items).toEqualIgnoringSymbols([1, 2, 3]);
    });
  });

  describe("References", () => {
    it("should return a Cell for reference properties", () => {
      const c = runtime.getCell<{
        id: number;
        metadata: {
          createdAt: string;
          type: string;
        };
      }>(
        space,
        "should return a Cell for reference properties 1",
        undefined,
        tx,
      );
      c.set({
        id: 1,
        metadata: {
          createdAt: "2025-01-06",
          type: "user",
        },
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.id).toBe(1);
      expect(isCell(value.metadata)).toBe(true);

      // The metadata cell should behave like a normal cell
      const metadataValue = value.metadata?.get();
      expect(metadataValue?.createdAt).toBe("2025-01-06");
      expect(metadataValue?.type).toBe("user");
    });

    it("Should support a reference at the root", () => {
      const c = runtime.getCell<{
        id: number;
        nested: { id: number };
      }>(
        space,
        "Should support a reference at the root 1",
        undefined,
        tx,
      );
      c.set({
        id: 1,
        nested: { id: 2 },
      });

      const schema = {
        type: "object",
        properties: {
          id: { type: "number" },
          nested: { $ref: "#", asCell: true },
        },
        asCell: true,
        required: ["id", "nested"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().id).toBe(1);
      expect(isCell(value.get().nested)).toBe(true);
      expect(value.get().nested.get().id).toBe(2);
    });
  });

  describe("Schema References", () => {
    it("should handle self-references with $ref: '#'", () => {
      const c = runtime.getCell<{
        name: string;
        children: Array<{ name: string; children: any[] }>;
      }>(
        space,
        "should handle self-references with $ref 1",
        undefined,
        tx,
      );
      c.set({
        name: "root",
        children: [
          { name: "child1", children: [] },
          { name: "child2", children: [] },
        ],
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[1].name).toBe("child2");
    });

    it("should handle circular references in objects", () => {
      const c = runtime.getCell<{
        name: string;
        parent: any;
        children: Array<{ name: string; parent: any; children: any[] }>;
      }>(
        space,
        "should handle circular references in objects 1",
        undefined,
        tx,
      );
      c.set({
        name: "root",
        parent: null,
        children: [
          { name: "child1", parent: null, children: [] },
          { name: "child2", parent: null, children: [] },
        ],
      });

      // Set up circular references using cell links
      c.key("parent").setRaw(c.getAsLink());
      c.key("children").key(0).key("parent").setRaw(c.getAsLink());
      c.key("children").key(1).key("parent").setRaw(c.getAsLink());

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          parent: { $ref: "#" },
          children: {
            type: "array",
            items: { $ref: "#" },
          },
        },
        required: ["name", "parent", "children"],
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get() as {
        name: string;
        parent: any;
        children: Array<{ name: string; parent: any; children: any[] }>;
      };

      // Verify the structure is maintained
      expect(value.name).toBe("root");
      expect(value.parent.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[0].parent.name).toBe("root");
      expect(value.children[1].name).toBe("child2");
      expect(value.children[1].parent.name).toBe("root");
    });

    it("should handle nested circular references", () => {
      const c = runtime.getCell<{
        name: string;
        nested: {
          name: string;
          items: Array<{ name: string; value: any }>;
        };
      }>(
        space,
        "should handle nested circular references 1",
        undefined,
        tx,
      );
      c.set({
        name: "root",
        nested: {
          name: "nested",
          items: [
            { name: "item1", value: null },
            { name: "item2", value: null },
          ],
        },
      });

      // Set up circular references using cell links
      c.key("nested").key("items").key(0).key("value").setRaw(
        c.getAsLink(),
      );
      c.key("nested").key("items").key(1).key("value").setRaw(
        c.key("nested").getAsLink(),
      );

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          nested: {
            type: "object",
            properties: {
              name: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    value: { $ref: "#" },
                  },
                },
              },
            },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get() as {
        name: string;
        nested: {
          name: string;
          items: Array<{ name: string; value: any }>;
        };
      };

      // Verify the structure is maintained
      expect(value.name).toBe("root");
      expect(value.nested.name).toBe("nested");
      expect(value.nested.items[0].name).toBe("item1");
      expect(value.nested.items[0].value.name).toBe("root");
      expect(value.nested.items[1].name).toBe("item2");
      expect(value.nested.items[1].value.name).toBe("nested");
    });

    it("should handle circular references with anyOf", () => {
      const c = runtime.getCell<{
        type: string;
        name: string;
        children: Array<{
          type: string;
          name: string;
          children?: any[];
          value?: any;
        }>;
      }>(
        space,
        "should handle circular references with anyOf 1",
        undefined,
        tx,
      );
      c.set({
        type: "node",
        name: "root",
        children: [
          { type: "node", name: "child1", children: [] },
          { type: "leaf", name: "child2", value: null },
        ],
      });

      // Set up circular references using cell links
      c.key("children").key(1).key("value").setRaw(c.getAsLink());

      const schema = {
        type: "object",
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          children: {
            type: "array",
            items: {
              anyOf: [
                { $ref: "#" },
                {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    name: { type: "string" },
                    value: { $ref: "#" },
                  },
                },
              ],
            },
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get() as {
        type: string;
        name: string;
        children: Array<{
          type: string;
          name: string;
          children?: any[];
          value?: any;
        }>;
      };

      // Verify the structure is maintained
      expect(value.name).toBe("root");
      expect(value.children[0].name).toBe("child1");
      expect(value.children[1].name).toBe("child2");
      expect(value.children[1].value.name).toBe("root");
    });

    it("Should support named $ref links", () => {
      const schema = {
        "$defs": {
          "LinkedNode": {
            type: "object",
            properties: {
              value: { type: "number" },
              next: { $ref: "#/$defs/LinkedNode" },
            },
            required: ["value"],
          },
        },
        $ref: "#/$defs/LinkedNode",
        asCell: true,
      } as const satisfies JSONSchema;

      const c = runtime.getCell(
        space,
        "Should support $defs references",
        schema,
        tx,
      );
      // TODO(@ubik2): this is a bit messy, but we need to have this to
      // have the rootSchema set
      const cell = c.asSchema(schema);
      cell.set({ value: 1, next: { value: 2, next: { value: 3 } } });

      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().value).toBe(1);
      expect(value.get().next.value).toBe(2);
      expect(value.get().next.next.value).toBe(3);
    });
  });

  describe("Key Navigation", () => {
    it("should preserve schema when using key()", () => {
      const c = runtime.getCell<{
        user: {
          profile: {
            name: string;
            metadata: { id: number };
          };
        };
      }>(
        space,
        "should preserve schema when using key 1",
        undefined,
        tx,
      );
      c.set({
        user: {
          profile: {
            name: "John",
            metadata: { id: 123 },
          },
        },
      });

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

      const cell = c.asSchema(schema);
      const userCell = cell.key("user");
      const profileCell = userCell.key("profile");
      const value = profileCell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.metadata)).toBe(true);
    });
  });

  describe("AnyOf Support", () => {
    it("should select the correct candidate for primitive types (number)", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "should select the correct candidate for primitive types (number) 1",
        undefined,
        tx,
      );
      c.set({ value: 42 });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBe(42);
    });

    it("should select the correct candidate for primitive types (string)", () => {
      const c = runtime.getCell<{ value: string }>(
        space,
        "should select the correct candidate for primitive types (string) 1",
        undefined,
        tx,
      );
      c.set({ value: "hello" });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBe("hello");
    });

    it("should merge object candidates in anyOf", () => {
      const c = runtime.getCell<{ item: { a: number; b: string } }>(
        space,
        "should merge object candidates in anyOf 1",
        undefined,
        tx,
      );
      c.set({ item: { a: 100, b: "merged" } });
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

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect((result.item as { a: number }).a).toBe(100);
      expect((result.item as { b: string }).b).toBe("merged");
    });

    it("should return undefined if no anyOf candidate matches for primitive types", () => {
      const c = runtime.getCell<{ value: boolean }>(
        space,
        "should return undefined if no anyOf candidate matches 1",
        undefined,
        tx,
      );
      c.set({ value: true });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should return undefined when value is an object but no anyOf candidate is an object", () => {
      const c = runtime.getCell<{ value: { a: number } }>(
        space,
        "should return undefined when value is an object 1",
        undefined,
        tx,
      );
      c.set({ value: { a: 1 } });
      const schema = {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "number" }, { type: "string" }],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.value).toBeUndefined();
    });

    it("should handle anyOf in array items", () => {
      const c = runtime.getCell<{ arr: any[] }>(
        space,
        "should handle anyOf in array items 1",
        undefined,
        tx,
      );
      c.set({ arr: [42, space, true] });
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

      const cell = c.asSchema(schema);
      const result = cell.get();
      expect(result.arr[0]).toBe(42);
      expect(result.arr[1]).toBe(space);
      expect(result.arr[2]).toBeUndefined();
    });

    it("should select the correct candidate when mixing object and array candidates", () => {
      // Case 1: When the value is an object, the object candidate should be used.
      const cObject = runtime.getCell<{ mixed: { foo: string } }>(
        space,
        "should select the correct candidate when mixing 1",
        undefined,
        tx,
      );
      cObject.set({ mixed: { foo: "bar" } });
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

      const cellObject = cObject.asSchema(schemaObject);
      const resultObject = cellObject.get();
      // Since the input is an object, the object candidate is selected.
      // TS doesn't infer `foo as string` when mixing objects and arrays, so have to cast.
      expect((resultObject.mixed as { foo: string }).foo).toBe("bar");

      // Case 2: When the value is an array, the array candidate should be used.
      const cArray = runtime.getCell<{ mixed: string[] }>(
        space,
        "should select the correct candidate when mixing 2",
        undefined,
        tx,
      );
      cArray.set({ mixed: ["bar", "baz"] });
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

      const cellArray = cArray.asSchema(schemaArray);
      const resultArray = cellArray.get();
      // Verify that the array candidate is chosen and returns the intended array.
      expect(resultArray).toEqualIgnoringSymbols({
        mixed: ["bar", "baz"],
      });
      expect(Array.isArray(resultArray.mixed)).toBe(true);
      expect(resultArray.mixed).toEqualIgnoringSymbols(["bar", "baz"]);
    });

    describe("Array anyOf Support", () => {
      it("should handle multiple array type options in anyOf", () => {
        const c = runtime.getCell<{ data: number[] }>(
          space,
          "should handle multiple array type options 1",
          undefined,
          tx,
        );
        c.set({ data: [1, 2, 3] });
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

        const cell = c.asSchema(schema);
        const result = cell.get();
        expect(result.data).toEqualIgnoringSymbols([1, 2, 3]);
      });

      it("should merge item schemas when multiple array options exist", () => {
        const c = runtime.getCell<{ data: any[] }>(
          space,
          "should merge item schemas when multiple array options 1",
          undefined,
          tx,
        );
        c.set({ data: ["hello", 42, true] });
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

        const cell = c.asSchema(schema);
        const result = cell.get();
        // Should keep string and number values, drop boolean
        expect(result.data).toEqualIgnoringSymbols([
          "hello",
          42,
          undefined,
        ]);
      });

      it("should handle nested anyOf in array items", () => {
        const c = runtime.getCell<{
          data: Array<{ type: string; value: string | number }>;
        }>(
          space,
          "should handle nested anyOf in array items 1",
          undefined,
          tx,
        );
        c.set({
          data: [
            { type: "text", value: "hello" },
            { type: "number", value: 42 },
          ],
        });
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

        const cell = c.asSchema(schema);
        const result = cell.get();
        expect(result.data).toEqualIgnoringSymbols([
          { type: "text", value: "hello" },
          { type: "number", value: 42 },
        ]);
      });

      it("should return empty array when no array options match", () => {
        const c = runtime.getCell<{ data: { key: string } }>(
          space,
          "should return empty array when no array options match 1",
          undefined,
          tx,
        );
        c.set({ data: { key: "value" } });
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

        const cell = c.asSchema(schema);
        const result = cell.get();
        expect(result.data).toBeUndefined();
      });

      it("should work for the vdom schema with $ref", () => {
        const plain = runtime.getCell<{
          type: string;
          name: string;
          props: { style: { color: string } };
          children: any[];
        }>(
          space,
          "should work for the vdom schema with $ref 1",
          undefined,
          tx,
        );
        plain.set({
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
        });

        const styleCell = runtime.getCell<{ color: string }>(
          space,
          "should work for the vdom schema with $ref 2",
          undefined,
          tx,
        );
        styleCell.set({ color: "red" });

        const innerTextCell = runtime.getCell<{ type: string; value: string }>(
          space,
          "should work for the vdom schema with $ref 4",
          undefined,
          tx,
        );
        innerTextCell.set({ type: "text", value: "world" });

        const childrenArrayCell = runtime.getCell<any[]>(
          space,
          "should work for the vdom schema with $ref 5",
          undefined,
          tx,
        );
        childrenArrayCell.set([
          { type: "text", value: "hello" },
          innerTextCell.getAsLink(),
        ]);

        const withLinks = runtime.getCell<{
          type: string;
          name: string;
          props: {
            style: any;
          };
          children: any[];
        }>(
          space,
          "should work for the vdom schema with $ref 3",
          undefined,
          tx,
        );
        withLinks.set({
          type: "vnode",
          name: "div",
          props: {
            style: styleCell,
          },
          children: [
            { type: "text", value: "single" },
            childrenArrayCell,
            "or just text",
          ],
        });

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
          const cell = doc.asSchema(vdomSchema);
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
      const c = runtime.getCell<{
        name: string;
        // age is not defined
      }>(
        space,
        "should use the default value when property is undefined 1",
        undefined,
        tx,
      );
      c.set({
        name: "John",
        // age is not defined
      });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", default: 30 },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(value.age).toBe(30);
    });

    it("should resolve defaults when using $ref in property schemas", () => {
      const schema = {
        $defs: {
          Settings: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              label: { type: "string" },
            },
            default: { enabled: true, label: "from ref" },
          },
        },
        type: "object",
        properties: {
          config: {
            $ref: "#/$defs/Settings",
            default: { enabled: false, label: "from property" },
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{
        config?: { enabled: boolean; label: string };
      }>(
        space,
        "should resolve defaults when using $ref in property schemas",
        undefined,
        tx,
      );
      c.set({});

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.config).toEqualIgnoringSymbols({
        enabled: false,
        label: "from property",
      });
    });

    it("should use the default value with asCell for objects", () => {
      const c = runtime.getCell<{
        name: string;
        // profile is not defined
      }>(
        space,
        "should use the default value with asCell for objects 1",
        undefined,
        tx,
      );
      c.set({
        name: "John",
        // profile is not defined
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.profile)).toBe(true);
      expect(value.profile.get()).toEqualIgnoringSymbols({
        bio: "Default bio",
        avatar: "default.png",
      });

      // Verify the profile cell can be updated
      value.profile.set({ bio: "Updated bio", avatar: "new.png" });
      expect(value.profile.get()).toEqualIgnoringSymbols({
        bio: "Updated bio",
        avatar: "new.png",
      });
    });

    it("should use the default value with asCell for arrays", () => {
      const c = runtime.getCell<{
        name: string;
        // tags is not defined
      }>(
        space,
        "should use the default value with asCell for arrays 1",
        undefined,
        tx,
      );
      c.set({
        name: "John",
        // tags is not defined
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("John");
      expect(isCell(value.tags)).toBe(true);
      expect(value.tags.get()).toEqualIgnoringSymbols([
        "default",
        "tags",
      ]);

      // Verify the tags cell can be updated
      value.tags.set(["updated", "tags", "list"]);
      expect(value.tags.get()).toEqualIgnoringSymbols([
        "updated",
        "tags",
        "list",
      ]);
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

      const c = runtime.getCell<{
        user: {
          name: string;
          // settings is not defined
        };
      }>(
        space,
        "should use the default value with nested schema 1",
        undefined,
        tx,
      );
      c.set({
        user: {
          name: "John",
          // settings is not defined
        },
      });

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.user.name).toBe("John");
      expect(isCell(value.user.settings)).toBe(true);

      const settings = value.user.settings.get();
      expect(settings.notifications).toBe(true);
      expect(isCell(settings.theme)).toBe(true);
      expect(isCell(settings.theme.get())).toBe(false);
      expect(settings.theme.get()).toEqualIgnoringSymbols({
        mode: "light",
        color: "red",
      });

      const c2 = runtime.getCell<{
        user: {
          name: string;
          // settings is set, but theme is not
          settings: { notifications: boolean };
        };
      }>(
        space,
        "should use the default value with nested schema 2",
        undefined,
        tx,
      );
      c2.set({
        user: {
          name: "John",
          // settings is set, but theme is not
          settings: { notifications: false },
        },
      });

      const cell2 = c2.asSchema(schema);
      const value2 = cell2.get();

      expect(value2.user.name).toBe("John");
      expect(isCell(value2.user.settings)).toBe(true);

      const settings2 = value2.user.settings.get();
      expect(settings2.notifications).toBe(false);
      expect(isCell(settings2.theme)).toBe(true);
      expect(settings2.theme.get()).toEqualIgnoringSymbols({
        mode: "dark",
        color: "blue",
      });
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

      const c = runtime.getCell<{
        items: Array<{ id: number; title?: string }>;
      }>(
        space,
        "should use the default value for array items 1",
        undefined,
        tx,
      );
      c.set({
        items: [
          { id: 1, title: "First Item" },
          // Second item has missing properties
          { id: 2 },
        ],
      });
      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.items?.[0].title).toBe("First Item");
      expect(value.items?.[1].title).toBe("Default Title");

      expect(isCell(value.items?.[0].metadata)).toBe(true);
      expect(isCell(value.items?.[1].metadata)).toBe(true);

      const c2 = runtime.getCell<any>(
        space,
        "should use the default value for array items 2",
        undefined,
        tx,
      );
      c2.set(undefined);
      const cell2 = c2.asSchema(schema);
      const value2 = cell2.get();

      expect(value2.items?.length).toBe(2);
      expect(value2.items?.[0].title).toBe("First Item");
      expect(value2.items?.[1].title).toBe("Default Title");

      expect(isCell(value2.items?.[0].metadata)).toBe(true);
      expect(isCell(value2.items?.[1].metadata)).toBe(true);

      expect(value2.items?.[0].metadata?.get()).toEqualIgnoringSymbols(
        {
          createdAt: "2023-01-01",
        },
      );
      expect(value2.items?.[1].metadata?.get()).toEqualIgnoringSymbols(
        {
          createdAt: "2023-01-02",
        },
      );
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

      const c = runtime.getCell<any>(
        space,
        "should handle default values with additionalProperties 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.config.knownProp).toBe("default");

      // These come from the default and should be processed as cells because of asCell in additionalProperties
      expect(isCell(value.config.feature1)).toBe(true);
      expect(isCell(value.config.feature2)).toBe(true);

      expect(value.config.feature1?.get()).toEqualIgnoringSymbols({
        enabled: true,
        value: "feature1",
      });
      expect(value.config.feature2?.get()).toEqualIgnoringSymbols({
        enabled: false,
        value: "feature2",
      });
    });

    it("should drop values blocked by additionalProperties: false", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              allowed: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        required: ["config"],
      } as const satisfies JSONSchema;

      const source = runtime.getCell<any>(
        space,
        "should drop values blocked by additionalProperties false",
        undefined,
        tx,
      );
      source.set({
        config: {
          allowed: "ok",
          forbidden: "nope",
        },
      });

      const value = source.asSchema(schema).get();

      expect(value.config.allowed).toBe("ok");
      expect(
        Object.prototype.hasOwnProperty.call(value.config, "forbidden"),
      ).toBe(false);
    });

    it(
      "should transform explicit additionalProperties objects from data",
      () => {
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
                asCell: true,
              },
              required: ["knownProp"],
            },
          },
          required: ["config"],
        } as const satisfies JSONSchema;

        const source = runtime.getCell<any>(
          space,
          "should transform explicit additionalProperties objects from data",
          undefined,
          tx,
        );
        source.set({
          config: {
            knownProp: "in schema",
            featureFlag: {
              enabled: true,
              value: "beta",
            },
          },
        });

        const value = source.asSchema(schema).get();

        expect(value.config.knownProp).toBe("in schema");
        expect(isCell(value.config.featureFlag)).toBe(true);
        expect(value.config.featureFlag?.get()).toEqualIgnoringSymbols(
          {
            enabled: true,
            value: "beta",
          },
        );
      },
    );

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

      const c = runtime.getCell<any>(
        space,
        "should use the default value at the root level 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);

      // The whole document should be a cell containing the default
      expect(isCell(cell)).toBe(true);
      const cellValue = cell.get();
      expect(isCell(cellValue)).toBe(true);
      const value = cellValue.get();
      expect(value).toEqualIgnoringSymbols({
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
      expect(cell.get().get()).toEqualIgnoringSymbols({
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

      const c = runtime.getCell<any>(
        space,
        "should make immutable cells if they provide the default value 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);
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

      const c = runtime.getCell<any>(
        space,
        "should make mutable cells if parent provides the default value 1",
        undefined,
        tx,
      );
      c.set(undefined);
      const cell = c.asSchema(schema);
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
      const c = runtime.getCell<{
        name: string;
        events: { $stream: boolean };
      }>(
        space,
        "should create a stream for properties marked with asStream 1",
        undefined,
        tx,
      );
      c.set({
        name: "Test Doc",
        events: { $stream: true },
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("Test Doc");
      expect(isStream(value.events)).toBe(true);

      // Verify it's a stream, i.e. no get functio
      expect((value as any).events.get).toBe(undefined);
    });

    it("should handle nested streams in objects", () => {
      const c = runtime.getCell<{
        user: {
          profile: {
            name: string;
            notifications: { $stream: boolean };
          };
        };
      }>(
        space,
        "should handle nested streams in objects 1",
        undefined,
        tx,
      );
      c.set({
        user: {
          profile: {
            name: "John",
            notifications: { $stream: true },
          },
        },
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value?.user?.profile?.name).toBe("John");
      expect(isStream(value?.user?.profile?.notifications)).toBe(true);
    });

    it("should not create a stream when property is missing", () => {
      const c = runtime.getCell<{
        name: string;
        // Missing events property
      }>(
        space,
        "should not create a stream when property is missing 1",
        undefined,
        tx,
      );
      c.set({
        name: "Test Doc",
        // Missing events property
      });

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

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.name).toBe("Test Doc");
      expect(isStream(value.events)).toBe(false);
    });

    it("should behave correctly when both asCell and asStream are in the schema", () => {
      const c = runtime.getCell<{
        cellData: { value: number };
        streamData: { $stream: boolean };
      }>(
        space,
        "should behave correctly when both asCell and asStream are in the schema 1",
        undefined,
        tx,
      );
      c.set({
        cellData: { value: 42 },
        streamData: { $stream: true },
      });

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

      const cell = c.asSchema(schema);
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

      const { promise: promise2 } = Promise.withResolvers();
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

      // Get the array result
      const result = listCell.get();

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

    it("should resolve to array indices when elements are not nested documents", () => {
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

      // Without nested documents, links should point to array indices
      expect(links[0].path).toEqual(["items", "0"]);
      expect(links[1].path).toEqual(["items", "1"]);
      expect(links[2].path).toEqual(["items", "2"]);

      // They should all have the same ID (the parent cell)
      expect(links[0].id).toBe(links[1].id);
      expect(links[1].id).toBe(links[2].id);
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

      // Plain objects have array index paths
      expect(links[1].path).toEqual(["items", "1"]);
      expect(links[3].path).toEqual(["items", "3"]);

      // Nested documents should have unique IDs
      expect(links[0].id).not.toBe(links[2].id);

      // Plain objects should share the parent cell's ID
      expect(links[1].id).toBe(links[3].id);
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

  describe("References", () => {
    it("should allow setting undefined when no promise is running", async () => {
      await runtime.idle();

      runtime.scheduler.runningPromise = undefined;
      expect(runtime.scheduler.runningPromise).toBeUndefined();
    });
  });
});

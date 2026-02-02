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
import { parseLink } from "../src/link-utils.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { sortAndCompactPaths } from "../src/reactive-dependencies.ts";
import { toCell } from "../src/back-to-cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { CellResult } from "../src/query-result-proxy.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

const signer2 = await Identity.fromPassphrase("test operator 2");
const space2 = signer2.did();

describe("Schema Support", () => {
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

      const cell = runtime.getCell<
        { value: string; current: Cell<{ label: string }> }
      >(
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
          currentByKeyValues.push(value as unknown as string);
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
      expect(first.getAsNormalizedFullLink().id).toEqual(
        innerCell.getAsNormalizedFullLink().id,
      );
      expect(first.getAsNormalizedFullLink().path).toEqual([]);
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqualIgnoringSymbols({ label: "first" });
      first.withTx(tx).set({ label: "first - update" });

      tx.commit();
      tx = runtime.edit();

      await runtime.idle();
      // TODO(@ubik2) - investigate why our currentValues now has "first-update"
      // twice instead of just once

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
      // "of:baedreifart2svf2yub6i73lfbv3foslfnnqkby6wbzyefhkxn3bfyjkbmi"
      const initial = runtime.getCell<{ foo: { label: string } }>(
        space,
        "should support nested sinks via asCell with aliases 1",
      );
      initial.withTx(tx).set({ foo: { label: "first" } });
      const initialEntityId = initial.entityId!;

      // "of:baedreiaumqclqrv3snkr57vua6gwe3jtvo6syvcekc3vw5wl52mh7nlop4"
      const linkCell = runtime.getCell<any>(
        space,
        "should support nested sinks via asCell with aliases 2",
      );
      linkCell.withTx(tx).setRaw(initial.getAsLink());
      const linkEntityId = linkCell.entityId!;

      // "of:baedreibxsezekir5bvzaf2cut4n2g6xvrpbnre7n77dtgi64ktfdbelavu"
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

      const root = docCell.asSchema<
        { value: string; current: Cell<{ label: string }> }
      >(schema);

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
      current.sink((value) => {
        currentByKeyValues.push(value as unknown as string);
      });

      // Make sure the schema is correct and it is still anchored at the root
      expect(current.schema).toEqual({ type: "string" });
      expect(parseLink(current.getAsLink({ includeSchema: true }))).toEqual({
        id: toURI(docCell.entityId!),
        path: ["current", "label"],
        space,
        schema: current.schema,
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
      // current is pointing to linkCell, which is pointing to initial
      expect(first.getAsNormalizedFullLink().id).toEqual(
        initial.getAsNormalizedFullLink().id,
      );
      expect(first.getAsNormalizedFullLink().path).toEqual(["foo"]);
      expect(isCell(first)).toBe(true);
      expect(first.get()).toEqualIgnoringSymbols({ label: "first" });
      const { asCell: _ignore, ...omitSchema } = schema.properties.current;
      expect(parseLink(first.getAsLink({ includeSchema: true }))).toEqual({
        id: toURI(initialEntityId),
        path: ["foo"],
        space,
        type: "application/json",
        schema: omitSchema,
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
        "root",
        "cancelled",
        "root - updated",
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
        "root",
        "cancelled",
        "root - updated",
        "cancelled",
        "root - updated",
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
        asCell: true,
        $ref: "#/$defs/Node",
        $defs: {
          "Node": {
            type: "object",
            properties: {
              id: { type: "number" },
              nested: { $ref: "#/$defs/Node", asCell: true },
            },
            required: ["id"],
          },
        },
      } as const satisfies JSONSchema;

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().id).toBe(1);
      expect(isCell(value.get().nested)).toBe(true);
      expect(value.get().nested!.get().id).toBe(2);
    });
  });

  describe("Schema References", () => {
    it("should handle self-references with $ref: '#/$defs/Node'", () => {
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
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: {
                type: "array",
                items: { $ref: "#/$defs/Node" },
              },
            },
            required: ["name", "children"],
          },
        },
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
      c.key("children").key(0).key("parent").resolveAsCell().setRaw(
        c.getAsLink(),
      );
      c.key("children").key(1).key("parent").resolveAsCell().setRaw(
        c.getAsLink(),
      );

      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          Root: {
            type: "object",
            properties: {
              name: { type: "string" },
              parent: { $ref: "#/$defs/Root" },
              children: {
                type: "array",
                items: { $ref: "#/$defs/Root" },
              },
            },
            required: ["name", "parent", "children"],
          },
        },
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
      c.key("nested").key("items").key(0).key("value").resolveAsCell().setRaw(
        c.getAsLink(),
      );
      c.key("nested").key("items").key(1).key("value").resolveAsCell().setRaw(
        c.key("nested").getAsLink(),
      );

      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          "Root": {
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
                        value: { $ref: "#/$defs/Root" },
                      },
                    },
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
      c.key("children").key(1).key("value").resolveAsCell().setRaw(
        c.getAsLink(),
      );

      // TODO(@ubik2) -- Temporarily disambiguating the anyOf clause, with
      // "required" property since I'm not yet merging properties when we
      // match multiples.
      const schema = {
        $ref: "#/$defs/Root",
        $defs: {
          "Root": {
            type: "object",
            properties: {
              type: { type: "string" },
              name: { type: "string" },
              children: {
                type: "array",
                items: {
                  anyOf: [
                    { $ref: "#/$defs/Root" },
                    {
                      type: "object",
                      properties: {
                        type: { type: "string" },
                        name: { type: "string" },
                        value: { $ref: "#/$defs/Root" },
                      },
                      required: ["value"],
                    },
                  ],
                },
              },
            },
            required: ["children"],
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
      const cell = c.asSchema(schema);
      cell.set({ value: 1, next: { value: 2, next: { value: 3 } } });

      const value = cell.get();

      expect(isCell(value)).toBe(true);
      expect(value.get().value).toBe(1);
      expect(value.get().next!.value).toBe(2);
      expect(value.get().next!.next!.value).toBe(3);
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

      // Runtime checks
      expect(value.name).toBe("John");
      expect(isCell(value.metadata)).toBe(true);

      // TypeScript type checks - these will fail to compile if types are 'any'
      type IsAny<T> = 0 extends (1 & T) ? true : false;

      // Check that userCell is NOT any
      type UserCellIsAny = IsAny<typeof userCell>;
      const _assertUserCellNotAny: UserCellIsAny extends false ? true : never =
        true;

      // Check that profileCell is NOT any
      type ProfileCellIsAny = IsAny<typeof profileCell>;
      const _assertProfileCellNotAny: ProfileCellIsAny extends false ? true
        : never = true;

      // Check that value is NOT any
      type ValueIsAny = IsAny<typeof value>;
      const _assertValueNotAny: ValueIsAny extends false ? true : never = true;
    });

    it("should preserve types through key() with explicit Cell types", () => {
      // Create a cell with explicit nested Cell type (not using Schema<>)
      const cell = runtime.getCell<
        { value: string; current: Cell<{ label: string }> }
      >(
        space,
        "should preserve types through key 1",
        {
          type: "object",
          properties: {
            current: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
              asCell: true,
            },
          },
          required: ["current"],
        } as const satisfies JSONSchema,
        tx,
      );

      // Navigate using .key()
      const currentCell = cell.key("current");
      const currentValue = currentCell.get();
      const labelCell = currentValue.key("label");
      const labelValue = labelCell.get();

      // Type checks - verify types are NOT any
      type IsAny<T> = 0 extends (1 & T) ? true : false;

      type CurrentCellIsAny = IsAny<typeof currentValue>;
      const _assertCurrentCellNotAny: CurrentCellIsAny extends false ? true
        : never = true;

      type LabelCellIsAny = IsAny<typeof labelValue>;
      const _assertLabelCellNotAny: LabelCellIsAny extends false ? true
        : never = true;

      // Verify that currentCell is Cell<Cell<{ label: string }>> (nested Cell, not unwrapped)
      type CurrentCellUnwrapped = typeof currentCell extends Cell<infer U> ? U
        : never;
      type CurrentIsCell = CurrentCellUnwrapped extends Cell<any> ? true
        : false;
      const _assertCurrentIsNestedCell: CurrentIsCell extends true ? true
        : never = true;
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
                additionalProperties: true,
              },
              {
                type: "object",
                properties: { b: { type: "string" } },
                required: ["b"],
                additionalProperties: true,
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
      // Undefined, since the boolean item makes the array invalid,
      // which then means the object's arr is invalid.
      expect(cell.get()).toBeUndefined();

      c.set({ arr: [42, space] });
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
                type: "object",
                required: ["type", "value"],
                anyOf: [
                  {
                    properties: {
                      type: { type: "string" },
                      value: { type: "string" },
                    },
                  },
                  {
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

      it("array element set as cell returned as non-cell", () => {
        const numberArrayCell = runtime.getCell<number[]>(
          space,
          "array of numbers",
          undefined,
          tx,
        );
        numberArrayCell.set([1, 2]);

        const arrayOfArrayCell = runtime.getCell<number[][]>(
          space,
          "array of arrays of numbers",
          undefined,
          tx,
        );
        arrayOfArrayCell.set([numberArrayCell, [3, 4]]);

        const arrayOfArraySchema = {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "number",
            },
          },
        } as const satisfies JSONSchema;

        const cell = arrayOfArrayCell.asSchema(arrayOfArraySchema);

        const result = cell.get();
        expect(Array.isArray(result)).toBeTruthy();
        expect(isCell(result)).toBeFalsy();
        const item = result[0];
        expect(Array.isArray(item)).toBeTruthy();
        expect(isCell(item)).toBeFalsy();
        expect(item[0]).toEqual(1);
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
        plain.setRaw({
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
        styleCell.setRaw({ color: "red" });

        const innerTextCell = runtime.getCell<{ type: string; value: string }>(
          space,
          "should work for the vdom schema with $ref 4",
          undefined,
          tx,
        );
        innerTextCell.setRaw({ type: "text", value: "world" });

        const childrenArrayCell = runtime.getCell<any[]>(
          space,
          "should work for the vdom schema with $ref 5",
          undefined,
          tx,
        );
        childrenArrayCell.setRaw([
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
        withLinks.setRaw({
          type: "vnode",
          name: "div",
          props: {
            style: styleCell,
          },
          children: [
            { type: "text", value: "single" },
            childrenArrayCell.getAsLink(),
            "or just text",
          ],
        });

        const vdomSchema = {
          $ref: "#/$defs/VDom",
          $defs: {
            VDom: {
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
                      { $ref: "#/$defs/VDom", asCell: true },
                      { type: "string", asCell: true },
                      { type: "number", asCell: true },
                      { type: "boolean", asCell: true },
                      {
                        type: "array",
                        items: { $ref: "#/$defs/VDom", asCell: true },
                      },
                    ],
                  },
                  asCell: true,
                },
              },
              required: ["type"],
            },
          },
        } as const satisfies JSONSchema;

        for (const doc of [plain, withLinks]) {
          const cell = doc.asSchema(vdomSchema);
          const result = cell.get();
          expect(result.type).toBe("vnode");
          expect(result.name).toBe("div");
          expect(isCell(result.props)).toBe(false);
          expect(isCell(result.props?.style)).toBe(true);
          expect(result.props!.style.get().color).toBe("red");
          expect(isCell(result.children)).toBe(true);
          const children = result.children!.get();
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

    it("should resolve defaults in $ref when using $ref in property schemas", () => {
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
          SettingsWithDefault: {
            $ref: "#/$defs/Settings",
            default: { enabled: false, label: "from default" },
          },
        },
        type: "object",
        properties: {
          config: {
            $ref: "#/$defs/SettingsWithDefault",
          },
        },
      } as const satisfies JSONSchema;

      const c = runtime.getCell<{
        config?: { enabled: boolean; label: string };
      }>(
        space,
        "should resolve defaults in $ref when using $ref in property schemas",
        undefined,
        tx,
      );
      c.set({});

      const cell = c.asSchema(schema);
      const value = cell.get();

      expect(value.config).toEqualIgnoringSymbols({
        enabled: false,
        label: "from default",
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
      // Our newly set values don't have a metadata property
      expect(value.items?.[0].metadata).toBeUndefined();
      expect(value.items?.[1].metadata).toBeUndefined();

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
        default: {}, // this makes us walk down for other defaults
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
      outer.setRaw({ inner: redir.getAsWriteRedirectLink() });

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
      cellC.setRaw(cellD.getAsLink());

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
      cellB.key("foo").setRaw(cellC.key("baz").getAsWriteRedirectLink());

      // of:baedreib4ycxtyccm5w2jmi2l6kx6hehjsnkwq6tu4end2kyaz7mzmmhtru
      const cellA = runtime.getCell<{ text: string }>(
        space,
        "redirect-test-ascell-a",
        cellASchema,
        tx,
      );
      // Then set up the link
      cellA.setRaw(
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
      cellC.key("value").setRaw(cellD.key("value").getAsLink());

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
      cellB.key("label").key("bar").setRaw(
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
      cellA.key("foo").setRaw(
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
      cellC.key("value").setRaw(cellD.key("value").getAsLink());

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
      cellB.key("label").key("bar").setRaw(
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
      cellA.key("foo").setRaw(
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
      cellC.setRaw(cellD.getAsLink());

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
      cellB.key("foo").setRaw(cellC.key("baz").getAsWriteRedirectLink());

      // of:baedreib4ycxtyccm5w2jmi2l6kx6hehjsnkwq6tu4end2kyaz7mzmmhtru
      const cellA = runtime.getCell<{ text: string }>(
        space,
        "redirect-test-ascell-a",
        cellASchema,
        tx,
      );
      // Then set up the link
      cellA.setRaw(
        cellB.key("foo").key("bar").getAsWriteRedirectLink(),
      );

      const cellAContents = cellA.get();
      const cellALink = (cellAContents as CellResult<any>)[toCell]()
        .getAsNormalizedFullLink();
      expect(cellALink.id).toBe(cellDLink.id);
      expect(cellALink.path).toEqual(["baz", "bar"]);
    });
  });
});

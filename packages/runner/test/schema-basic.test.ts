// Basic schema type tests: primitive types, references, schema references,
// and key navigation.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, isCell } from "../src/cell.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Schema - Basic Types and References", () => {
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
});

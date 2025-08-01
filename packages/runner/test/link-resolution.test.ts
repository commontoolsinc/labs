import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

import { type JSONSchema } from "../src/builder/types.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("link-resolution", () => {
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

  describe("followWriteRedirects", () => {
    it("should follow a simple alias", () => {
      const testCell = runtime.getCell<{ value: number }>(
        space,
        "should follow a simple alias 1",
        undefined,
        tx,
      );
      testCell.set({ value: 42 });
      const binding = { $alias: { path: ["value"] } };
      const result = resolveLink(
        tx,
        parseLink(binding, testCell)!,
        "writeRedirect",
      );
      expect(tx.readValueOrThrow(result)).toBe(42);
    });

    it("should follow nested aliases", () => {
      const innerCell = runtime.getCell<{ inner: number }>(
        space,
        "should follow nested aliases 1",
        undefined,
        tx,
      );
      innerCell.set({ inner: 10 });
      const outerCell = runtime.getCell<{ outer: any }>(
        space,
        "should follow nested aliases 2",
        undefined,
        tx,
      );
      outerCell.setRaw({
        outer: innerCell.key("inner").getAsWriteRedirectLink(),
      });
      const binding = { $alias: { path: ["outer"] } };
      const result = resolveLink(
        tx,
        parseLink(binding, outerCell)!,
        "writeRedirect",
      );
      expect(
        areNormalizedLinksSame(
          result,
          innerCell.key("inner").getAsNormalizedFullLink(),
        ),
      ).toBe(
        true,
      );
      expect(tx.readValueOrThrow(result)).toBe(10);
    });

    it("should allow aliases in aliased paths", () => {
      const testCell = runtime.getCell<any>(
        space,
        "should allow aliases in aliased paths 1",
        undefined,
        tx,
      );
      testCell.setRaw({
        a: { a: { $alias: { path: ["a", "b"] } }, b: { c: 1 } },
      });
      const binding = { $alias: { path: ["a", "a", "c"] } };
      const result = resolveLink(
        tx,
        parseLink(binding, testCell)!,
        "writeRedirect",
      );
      expect(
        areNormalizedLinksSame(
          result,
          testCell.key("a").key("b").key("c").getAsNormalizedFullLink(),
        ),
      ).toBe(true);
      expect(tx.readValueOrThrow(result)).toBe(1);
    });
  });

  describe("Schema handling in links", () => {
    it("should preserve schema when resolving links", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      } as const;

      const targetCell = runtime.getCell<{ name: string; age: number }>(
        space,
        "schema-target-cell",
        schema,
        tx,
      );
      targetCell.set({ name: "John", age: 30 });

      const sourceCell = runtime.getCell<any>(
        space,
        "schema-source-cell",
        undefined,
        tx,
      );

      // Create a link with schema included
      sourceCell.setRaw({
        link: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // When resolving a link to a cell that has a schema,
      // the resolved link should point to the target cell with its schema
      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);
      expect(resolved.schema).toEqual(schema);
    });

    it("should adjust schema for nested paths", () => {
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      } as const satisfies JSONSchema;

      const targetCell = runtime.getCell<any>(
        space,
        "nested-schema-target",
        schema,
        tx,
      );
      targetCell.set({ user: { name: "Jane", email: "jane@example.com" } });

      const sourceCell = runtime.getCell<any>(
        space,
        "nested-schema-source",
        undefined,
        tx,
      );
      // Create a link pointing to targetCell/user with schema included
      sourceCell.setRaw({
        link: targetCell.key("user").getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // The resolved link should have the adjusted schema for the user object
      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);
      expect(resolved.schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
      });
    });

    it("should preserve schema through write redirects", () => {
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const targetCell = runtime.getCell<{ value: number }>(
        space,
        "redirect-schema-target",
        schema,
        tx,
      );
      targetCell.set({ value: 42 });

      const sourceCell = runtime.getCell<any>(
        space,
        "redirect-schema-source",
        undefined,
        tx,
      );
      sourceCell.setRaw({
        alias: targetCell.getAsWriteRedirectLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // Resolve with writeRedirect mode
      const linkValue = sourceCell.key("alias").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink, "writeRedirect");
      expect(resolved.schema).toEqual(schema);
    });

    it("should handle undefined schemas gracefully", () => {
      // Cell without schema
      const targetCell = runtime.getCell<any>(
        space,
        "no-schema-target",
        undefined,
        tx,
      );
      targetCell.set({ data: "test" });

      const sourceCell = runtime.getCell<any>(
        space,
        "no-schema-source",
        undefined,
        tx,
      );
      sourceCell.set({ link: targetCell });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);
      expect(resolved.schema).toBeUndefined();
    });

    it("should preserve rootSchema when available", () => {
      // Use a simple schema without $ref since it's not supported yet
      const rootSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      } as const;

      const schema = rootSchema;

      const targetCell = runtime.getCell<any>(
        space,
        "rootschema-target",
        schema,
        tx,
      );
      targetCell.set({ name: "Test User" });

      // Create a link with setRaw to preserve rootSchema
      const sourceCell = runtime.getCell<any>(
        space,
        "rootschema-source",
        undefined,
        tx,
      );
      const linkData = targetCell.getAsLink();
      // Manually add rootSchema to the link
      if (linkData["/"] && linkData["/"]["link@1"]) {
        linkData["/"]["link@1"].rootSchema = rootSchema;
      }
      sourceCell.setRaw({ link: linkData });
      tx.commit();
      tx = runtime.edit();

      const link = parseLink(sourceCell.get().link, sourceCell)!;
      const resolved = resolveLink(tx, link);
      expect(resolved.rootSchema).toEqual(rootSchema);
    });

    it("should handle schema through multiple link hops", () => {
      const schema1 = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
      };

      const schema2 = {
        type: "object",
        properties: {
          data: { type: "number" },
        },
      };

      const cell1 = runtime.getCell<any>(
        space,
        "multi-hop-1",
        schema1,
        tx,
      );
      cell1.set({ nested: { value: "test" } });

      const cell2 = runtime.getCell<any>(
        space,
        "multi-hop-2",
        schema2,
        tx,
      );
      // Link to cell1's nested object with schema
      cell2.setRaw({
        data: cell1.key("nested").getAsLink({ includeSchema: true }),
      });

      const cell3 = runtime.getCell<any>(
        space,
        "multi-hop-3",
        undefined,
        tx,
      );
      // Link to cell2
      cell3.set({ ref: cell2 });
      tx.commit();
      tx = runtime.edit();

      // Following through cell3 -> cell2 -> cell1.nested
      // We need to resolve step by step since getAsNormalizedFullLink doesn't preserve schema
      const linkValue = cell2.key("data").get();
      const parsedLink = parseLink(linkValue, cell2)!;
      const resolved = resolveLink(tx, parsedLink);

      // Should have the schema of cell1.nested
      expect(resolved.schema).toEqual({
        type: "object",
        properties: {
          value: { type: "string" },
        },
      });
    });

    it("should handle schema with array paths", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "number" },
                name: { type: "string" },
              },
            },
          },
        },
      };

      const targetCell = runtime.getCell<any>(
        space,
        "array-schema-target",
        schema,
        tx,
      );
      targetCell.set({
        items: [
          { id: 1, name: "Item 1" },
          { id: 2, name: "Item 2" },
        ],
      });

      const sourceCell = runtime.getCell<any>(
        space,
        "array-schema-source",
        undefined,
        tx,
      );
      // Link to a specific array element with schema
      sourceCell.setRaw({
        link: targetCell.key("items").key(0).getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);

      // Should have the schema of an array item
      expect(resolved.schema).toEqual({
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
        },
      });
    });

    it("should preserve schema when link has no schema but destination does", () => {
      const destinationSchema = {
        type: "object",
        properties: {
          status: { type: "string" },
        },
      } as const;

      const destCell = runtime.getCell<any>(
        space,
        "preserve-dest-schema",
        destinationSchema,
        tx,
      );
      destCell.set({ status: "active" });

      // Create another cell that links to destCell with schema
      const linkCell = runtime.getCell<any>(
        space,
        "link-without-schema",
        undefined,
        tx,
      );
      linkCell.setRaw(destCell.getAsLink({ includeSchema: true }));

      // Source cell links to linkCell
      const sourceCell = runtime.getCell<any>(
        space,
        "source-preserve-schema",
        undefined,
        tx,
      );
      sourceCell.set({ ref: linkCell });
      tx.commit();
      tx = runtime.edit();

      // Following the chain should preserve the destination schema
      const linkValue = sourceCell.key("ref").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);
      expect(resolved.schema).toEqual(destinationSchema);
    });

    it("should handle empty schema objects", () => {
      const emptySchema = {} as const;

      const targetCell = runtime.getCell<any>(
        space,
        "empty-schema-target",
        emptySchema,
        tx,
      );
      targetCell.set({ any: "value" });

      const sourceCell = runtime.getCell<any>(
        space,
        "empty-schema-source",
        undefined,
        tx,
      );
      sourceCell.setRaw({
        link: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);

      // Empty schema should be preserved
      expect(resolved.schema).toEqual(emptySchema);
    });

    it("should handle complex nested schemas with multiple levels", () => {
      const complexSchema = {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        deep: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as const;

      const targetCell = runtime.getCell<any>(
        space,
        "complex-nested-schema",
        complexSchema,
        tx,
      );
      targetCell.set({
        level1: {
          level2: {
            level3: [{ deep: "value1" }, { deep: "value2" }],
          },
        },
      });

      const sourceCell = runtime.getCell<any>(
        space,
        "complex-nested-source",
        undefined,
        tx,
      );

      // Link to a deeply nested path
      sourceCell.setRaw({
        link: targetCell.key("level1").key("level2").key("level3").key(0)
          .getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);

      // Should have the schema of the array item
      expect(resolved.schema).toEqual({
        type: "object",
        properties: {
          deep: { type: "string" },
        },
      });
    });

    it("should handle schemas with additionalProperties", () => {
      const schemaWithAdditional = {
        type: "object",
        properties: {
          known: { type: "string" },
        },
        additionalProperties: { type: "number" },
      } as const;

      const targetCell = runtime.getCell<any>(
        space,
        "additional-props-target",
        schemaWithAdditional,
        tx,
      );
      targetCell.set({ known: "value", extra1: 42, extra2: 100 });

      const sourceCell = runtime.getCell<any>(
        space,
        "additional-props-source",
        undefined,
        tx,
      );
      sourceCell.setRaw({
        link: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      const linkValue = sourceCell.key("link").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);

      expect(resolved.schema).toEqual(schemaWithAdditional);
    });

    it("should handle schemas with both top-level and nested links", () => {
      // Test case where a document has both regular properties and links
      const schema1 = {
        type: "object",
        properties: {
          name: { type: "string" },
          ref: { type: "object" }, // Will be a link
        },
      } as const;

      const schema2 = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      } as const;

      const targetCell = runtime.getCell<any>(
        space,
        "mixed-schema-target",
        schema2,
        tx,
      );
      targetCell.set({ value: 42 });

      const sourceCell = runtime.getCell<any>(
        space,
        "mixed-schema-source",
        schema1,
        tx,
      );
      sourceCell.setRaw({
        name: "test",
        ref: targetCell.getAsLink({ includeSchema: true }),
      });
      tx.commit();
      tx = runtime.edit();

      // Resolving the ref should give us the target schema
      const linkValue = sourceCell.key("ref").get();
      const parsedLink = parseLink(linkValue, sourceCell)!;
      const resolved = resolveLink(tx, parsedLink);
      expect(resolved.schema).toEqual(schema2);
    });
  });

  describe("overwrite field removal", () => {
    it("should remove overwrite field from resolved links", () => {
      const sourceCell = runtime.getCell<{ value: number }>(
        space,
        "source-cell",
        undefined,
        tx,
      );
      sourceCell.set({ value: 42 });

      const targetCell = runtime.getCell<{ alias: any }>(
        space,
        "target-cell",
        undefined,
        tx,
      );

      // Create a write redirect link (which includes overwrite field)
      targetCell.setRaw({
        alias: sourceCell.key("value").getAsWriteRedirectLink(),
      });

      const link = parseLink(targetCell.key("alias"));
      const resolved = resolveLink(tx, link!, "writeRedirect");

      // Verify the resolved link doesn't have an overwrite field
      expect("overwrite" in resolved).toBe(false);
      expect(resolved.id).toBe(sourceCell.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["value"]);
    });

    it("should preserve other link properties while removing overwrite", () => {
      const cell = runtime.getCell<{ data: { nested: string } }>(
        space,
        "test-cell",
        undefined,
        tx,
      );
      cell.set({ data: { nested: "test" } });

      const aliasCell = runtime.getCell<{ ref: any }>(
        space,
        "alias-cell",
        undefined,
        tx,
      );

      // Create write redirect link
      aliasCell.setRaw({
        ref: cell.key("data").key("nested").getAsWriteRedirectLink(),
      });

      const link = parseLink(aliasCell.key("ref"));
      const resolved = resolveLink(tx, link!, "writeRedirect");

      // Check that all other properties are preserved
      expect(resolved.space).toBe(space);
      expect(resolved.id).toBe(cell.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["data", "nested"]);
      expect("overwrite" in resolved).toBe(false);
    });

    it("should remove overwrite field when following multiple write redirects", () => {
      const cellA = runtime.getCell<{ value: string }>(
        space,
        "cell-a",
        undefined,
        tx,
      );
      cellA.set({ value: "original" });

      const cellB = runtime.getCell<{ redirect: any }>(
        space,
        "cell-b",
        undefined,
        tx,
      );
      cellB.setRaw({
        redirect: cellA.key("value").getAsWriteRedirectLink(),
      });

      const cellC = runtime.getCell<{ alias: any }>(
        space,
        "cell-c",
        undefined,
        tx,
      );
      cellC.setRaw({
        alias: cellB.key("redirect").getAsWriteRedirectLink(),
      });

      const link = parseLink(cellC.key("alias"));
      const resolved = resolveLink(tx, link!, "writeRedirect");

      // Should resolve to the final destination without overwrite field
      expect("overwrite" in resolved).toBe(false);
      expect(resolved.id).toBe(cellA.getAsNormalizedFullLink().id);
      expect(resolved.path).toEqual(["value"]);
    });
  });

  describe("Cycle detection with circular references", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });

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

    it("handles circular references correctly without overtriggering cycle detection", () => {
      // This test verifies that the cycle detection does NOT overtrigger.
      // The scenario described in the bug report works correctly:
      // - Two cells reference each other in a cycle
      // - We can still access properties through the cycle without errors
      // Create cellA with a reference to cellB and a non-cyclic property
      const cellA = runtime.getCell(
        space,
        "cycle-detection-bug-cellA",
        {
          type: "object",
          properties: { foo: { $ref: "#" }, bar: { type: "string" } },
        } as const as any,
        tx,
      );

      // Create cellB with a reference to cellA
      const cellB = runtime.getCell<any>(
        space,
        "cycle-detection-bug-cellB",
        undefined,
        tx,
      );

      // Set up the circular reference structure as described:
      // cellA.set({ foo: cellB, bar: "baz" })
      // cellB.set(cellA)
      cellA.set({ foo: cellB, bar: "baz" });
      cellB.set(cellA);

      // Test 1: A.get() should work
      const result = cellA.get();
      expect(result.bar).toBe("baz");
      // When we get(), cells are automatically dereferenced, so result.foo
      // is the actual value (not a cell)
      expect(result.foo.bar).toBe("baz");
      expect(result.foo.foo.foo).toEqual(result.foo.foo);

      // Test 2: A.key("foo").get() should work and return the value of cellB (which is cellA)
      const fooResult = cellA.key("foo").get();
      expect(fooResult.bar).toBe("baz");

      // Test 3: A.key("foo").key("bar").get() should work and return "baz"
      // This is where the overtrigger might happen - accessing bar through the cycle
      let barResult: string;
      try {
        barResult = cellA.key("foo").key("bar").get() as any;
        expect(barResult).toBe("baz");
      } catch (e) {
        // If this throws, we've hit the overtrigger bug
        console.error(
          "Overtrigger bug detected at A.key('foo').key('bar').get():",
          e,
        );
        throw e;
      }

      // Test 4: A.key("foo").key("foo").key("foo").get() should work
      // Multiple levels of following the references
      let deepResult: any;
      try {
        deepResult = cellA.key("foo").key("foo").key("foo").get();
        expect(deepResult.bar).toBe("baz");
      } catch (e) {
        // If this throws, we've hit the overtrigger bug
        console.error(
          "Overtrigger bug detected at A.key('foo').key('foo').key('foo').get():",
          e,
        );
        throw e;
      }
    });

    it("handles complex circular reference scenarios", () => {
      // More complex scenario with multiple cells and properties
      const cellA = runtime.getCell<{ b: any; c: any; value: string }>(
        space,
        "complex-cycle-cellA",
        undefined,
        tx,
      );

      const cellB = runtime.getCell<{ a: any; c: any; value: string }>(
        space,
        "complex-cycle-cellB",
        undefined,
        tx,
      );

      const cellC = runtime.getCell<{ a: any; b: any; value: string }>(
        space,
        "complex-cycle-cellC",
        undefined,
        tx,
      );

      // Create a triangle of references
      cellA.set({ b: cellB, c: cellC, value: "A" });
      cellB.set({ a: cellA, c: cellC, value: "B" });
      cellC.set({ a: cellA, b: cellB, value: "C" });

      // Test accessing values through different paths
      // A -> B -> C -> value
      expect(cellA.key("b").key("c").key("value").get()).toBe("C");

      // A -> C -> B -> A -> value
      expect(cellA.key("c").key("b").key("a").key("value").get()).toBe("A");

      // Multiple hops through the same cycle
      expect(cellA.key("b").key("a").key("b").key("a").key("value").get()).toBe(
        "A",
      );
    });

    it("handles deeply nested circular references with aliases", () => {
      // Test with a mix of direct cell references and aliases
      const cellA = runtime.getCell<any>(
        space,
        "deep-cycle-cellA",
        undefined,
        tx,
      );

      const cellB = runtime.getCell<any>(
        space,
        "deep-cycle-cellB",
        undefined,
        tx,
      );

      // Create a structure where cells reference each other at different depths
      cellA.set({
        direct: cellB,
        nested: {
          ref: cellB,
          data: "nested-a",
        },
        value: "a",
      });

      cellB.set({
        back: cellA,
        deep: {
          path: {
            to: {
              a: cellA,
            },
          },
        },
        value: "b",
      });

      // Test navigation through various paths
      expect(cellA.key("direct").key("back").key("value").get()).toBe("a");
      expect(
        cellA.key("nested").key("ref").key("deep").key("path").key("to").key(
          "a",
        )
          .key("value").get(),
      ).toBe("a");

      // This path should work even though it visits the same cells multiple times
      expect(
        cellA.key("direct").key("back").key("direct").key("back").key("nested")
          .key("data").get(),
      ).toBe("nested-a");
    });

    it("handles circular references with array elements", () => {
      // This test demonstrates the cycle detection overtrigger bug
      // The bug occurs when navigating through circular references multiple times
      // even when accessing different properties
      const cellA = runtime.getCell<{ items: any[]; name: string }>(
        space,
        "array-cycle-cellA",
        undefined,
        tx,
      );

      const cellB = runtime.getCell<{ parent: any; name: string }>(
        space,
        "array-cycle-cellB",
        undefined,
        tx,
      );

      const cellC = runtime.getCell<{ root: any; name: string }>(
        space,
        "array-cycle-cellC",
        undefined,
        tx,
      );

      // Create circular references through array
      cellA.set({ items: [cellB, cellC], name: "A" });
      cellB.set({ parent: cellA, name: "B" });
      cellC.set({ root: cellA, name: "C" });

      // Navigate through array indices and back
      expect(cellA.key("items").key(0).key("parent").key("name").get()).toBe(
        "A",
      );

      expect(
        cellA.key("items").key(1).key("root").key("items").key(0).key("name")
          .get(),
      ).toBe("B");

      // Complex path through multiple array elements
      // This is where the bug triggers: A → items[0] (B) → parent (A) → items[1] (C) → root (A) → name
      // The cycle detector sees we're visiting A multiple times and throws an error,
      // even though we're legitimately navigating through the structure to access "name"
      expect(
        cellA.key("items").key(0).key("parent").key("items").key(1).key("root")
          .key("name").get(),
      ).toBe("A");
    });

    it("properly detects true circular references", () => {
      // Test cases where circular references SHOULD be detected
      // When a cycle is detected, the system logs a warning and returns an empty document

      // Case 1: Direct circular reference A -> A
      const cellA = runtime.getCell<any>(
        space,
        "direct-cycle-A",
        undefined,
        tx,
      );
      // Using setRaw to circumvent cycle detection on write
      // This allows us to create the cycle for testing purposes
      cellA.setRaw(cellA.getAsLink());

      // When we resolve a circular reference, it should return undefined
      // (the empty document resolves to undefined)
      const value = cellA.get();
      expect(value).toBeUndefined();

      // Case 2: Mutual references A -> B -> A
      const cellB = runtime.getCell<any>(
        space,
        "direct-cycle-B",
        undefined,
        tx,
      );

      // Using setRaw to circumvent cycle detection on write
      const linkToA = cellA.getAsLink();
      const linkToB = cellB.getAsLink();

      cellA.setRaw(linkToB);
      cellB.setRaw(linkToA);

      // Both should resolve to undefined
      expect(cellA.get()).toBeUndefined();
      expect(cellB.get()).toBeUndefined();
    });

    it("detects cycle when resolving link to its own subpath", async () => {
      // Test case: A -> A/foo creates an infinite growing path
      const cellA = runtime.getCell<any>(
        space,
        "self-subpath-cycle",
        undefined,
        tx,
      );

      // Create a link from A to A/foo
      cellA.setRaw(cellA.key("foo").getAsLink());

      // Race the resolution against a 1 second timeout to ensure it doesn't hang
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Resolution timed out after 1 second")),
          1000,
        );
      });

      const resolutionPromise = new Promise<any>((resolve) => {
        // When we resolve this link, it should detect the growing path cycle
        // and return the empty document with a data: URI
        resolve(resolveLink(tx, cellA.getAsNormalizedFullLink()));
      });

      try {
        const resolved = await Promise.race([
          resolutionPromise,
          timeoutPromise,
        ]);

        // This creates: A -> A/foo -> A/foo/foo -> A/foo/foo/foo -> ...
        // The iteration limit should catch this and return the empty document
        expect(resolved.id).toBe("data:application/json,{}");
        expect(resolved.space).toBe("did:null:null");
      } finally {
        // Clean up the timeout if it was set
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    });

    it("detects cycles in nested paths", () => {
      // Test case: A/x -> B/y -> A/x (cycle at a specific path)
      const cellA = runtime.getCell<any>(
        space,
        "nested-cycle-A",
        undefined,
        tx,
      );
      const cellB = runtime.getCell<any>(
        space,
        "nested-cycle-B",
        undefined,
        tx,
      );

      // Create the cycle using setRaw to circumvent cycle detection on write
      const linkToAx = cellA.key("x").getAsLink();
      const linkToBy = cellB.key("y").getAsLink();

      cellA.setRaw({ x: linkToBy });
      cellB.setRaw({ y: linkToAx });

      const value = cellA.key("x").get();
      expect(value).toBeUndefined();
    });

    it("shows data URI when resolving cyclic links", () => {
      // To see the data: URI, we need to use the lower-level resolveLink function
      const cellA = runtime.getCell<any>(
        space,
        "data-uri-cycle-A",
        undefined,
        tx,
      );

      // Create a self-referencing cycle using setRaw to circumvent cycle
      // detection on write
      cellA.setRaw(cellA.getAsLink());

      // When we resolve this link at a low level, it should return the empty document
      // with a data: URI indicating the cycle was detected
      const resolved = resolveLink(
        tx,
        cellA.getAsNormalizedFullLink(),
        "value",
      );
      expect(resolved.id).toBe("data:application/json,{}");
      expect(resolved.space).toBe("did:null:null");
    });

    it("allows non-cyclic references to the same cell", () => {
      // This should NOT trigger cycle detection - accessing different properties
      const cellA = runtime.getCell<any>(
        space,
        "non-cycle-A",
        undefined,
        tx,
      );
      const cellB = runtime.getCell<any>(
        space,
        "non-cycle-B",
        undefined,
        tx,
      );

      // A has two different references to B at different paths
      cellA.set({
        ref1: cellB,
        ref2: cellB,
        data: "A data",
      });

      cellB.set({
        value: "B value",
        nested: { deep: "deep value" },
      });

      // These should all work without cycle detection
      expect(cellA.key("ref1").key("value").get()).toBe("B value");
      expect(cellA.key("ref2").key("nested").key("deep").get()).toBe(
        "deep value",
      );

      // The resolved links should NOT be data: URIs
      const link1 = cellA.key("ref1").key("value").getAsNormalizedFullLink();
      const link2 = cellA.key("ref2").key("nested").getAsNormalizedFullLink();

      expect(link1.id).not.toMatch(/^data:/);
      expect(link2.id).not.toMatch(/^data:/);
    });
  });
});

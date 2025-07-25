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
      } as const as JSONSchema,
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
    expect(result.foo.foo).toEqual(result.foo);

    // Test 2: A.key("foo").get() should work and return the value of cellB (which is cellA)
    const fooResult = cellA.key("foo").get();
    expect(fooResult.bar).toBe("baz");

    // Test 3: A.key("foo").key("bar").get() should work and return "baz"
    // This is where the overtrigger might happen - accessing bar through the cycle
    let barResult: string;
    try {
      barResult = cellA.key("foo").key("bar").get();
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
      cellA.key("nested").key("ref").key("deep").key("path").key("to").key("a")
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
    expect(cellA.key("items").key(0).key("parent").key("name").get()).toBe("A");

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
      const resolved = await Promise.race([resolutionPromise, timeoutPromise]);

      // This creates: A -> A/foo -> A/foo/foo -> A/foo/foo/foo -> ...
      // The iteration limit should catch this and return the empty document
      expect(resolved.id).toBe("data:application/json,");
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
    expect(resolved.id).toBe("data:application/json,");
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

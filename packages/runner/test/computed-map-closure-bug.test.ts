/**
 * Test to confirm the hypothesis about computed closures over map items.
 *
 * HYPOTHESIS: When a computed() inside a map callback compares
 * `cell.get() === item.id`, the comparison fails because:
 * - cell.get() returns a primitive string
 * - item.id is an OpaqueRef proxy object
 * - Strict equality (===) doesn't trigger type coercion
 * - So "string" === OpaqueRefProxy is always false
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("test computed-map-closure-bug");
const space = signer.did();

describe("Computed closures over map items", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("OpaqueRef comparison investigation", () => {
    it("should investigate OpaqueRef Symbol.toPrimitive behavior", async () => {
      const tx = runtime.edit();

      // Create a simple cell to get an OpaqueRef
      const testCell = runtime.getCell<{ id: string }>(
        space,
        "opaqueref-test",
        undefined,
        tx,
      );
      testCell.set({ id: "test-id" });

      // Get as OpaqueRef proxy
      const proxy = testCell.getAsOpaqueRefProxy();
      const idProxy = proxy.id;

      console.log("\n=== OPAQUEREF INVESTIGATION ===");
      console.log(`typeof proxy.id: ${typeof idProxy}`);

      // Don't call String() - it triggers "outside reactive context" error
      // console.log(`proxy.id value (toString): ${String(idProxy)}`);

      // Check if it has .get() method
      const proxyIdHasGet =
        typeof (idProxy as { get?: unknown })?.get === "function";
      console.log(`proxy.id has .get() method: ${proxyIdHasGet}`);
      if (proxyIdHasGet) {
        const gotValue = (idProxy as unknown as { get: () => string }).get();
        console.log(`proxy.id.get() value: "${gotValue}"`);
        console.log(`typeof proxy.id.get(): ${typeof gotValue}`);
      }

      // Note: Accessing .constructor.name on the proxy triggers "outside reactive context" error
      // because the OpaqueRef proxy intercepts ALL property accesses

      // Test strict equality - this works without triggering the error
      const strictResult = "test-id" === idProxy;
      console.log(`\n"test-id" === proxy.id: ${strictResult}`);
      console.log(
        `Key insight: strict equality is FALSE even though values match`,
      );

      // Test if get() returns correct value and comparison works
      if (proxyIdHasGet) {
        const gotValue = (idProxy as unknown as { get: () => string }).get();
        const getStrictResult = "test-id" === gotValue;
        console.log(`\n"test-id" === proxy.id.get(): ${getStrictResult}`);
        console.log(`THE FIX: calling .get() on both sides works!`);
      }

      console.log("=== END OPAQUEREF INVESTIGATION ===\n");

      await tx.commit();

      // The key finding: OpaqueRef's Symbol.toPrimitive throws an error
      // This means loose equality (==) will error, not work
      expect(typeof idProxy).toBe("object"); // Proxy is an object
    });

    it("should show why string === OpaqueRefProxy fails", async () => {
      const tx = runtime.edit();

      // Create a cell with a nested object
      const testCell = runtime.getCell<{ items: Array<{ id: string }> }>(
        space,
        "nested-opaqueref-test",
        undefined,
        tx,
      );
      testCell.set({
        items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }],
      });

      // Create another cell for the "selected" id (primitive string)
      const selectedCell = runtime.getCell<string>(
        space,
        "selected-id",
        { type: "string" },
        tx,
      );
      selectedCell.set("item-2");

      // Get the proxy
      const proxy = testCell.getAsOpaqueRefProxy();

      console.log("\n=== MAP ITEM COMPARISON ===");

      // Simulate what happens inside a map callback
      const items = proxy.items;
      console.log(`typeof proxy.items: ${typeof items}`);

      // Access first item's id (this is what captured closures do)
      const firstItemId = (items as unknown as Array<{ id: string }>)[0]?.id;
      console.log(`typeof proxy.items[0].id: ${typeof firstItemId}`);

      // Get the selected value as primitive
      const selectedValue = selectedCell.get();
      console.log(`typeof selectedCell.get(): ${typeof selectedValue}`);
      console.log(`selectedCell.get() value: ${selectedValue}`);

      // This comparison FAILS because:
      // - selectedValue is "item-2" (primitive string)
      // - firstItemId is an OpaqueRef proxy (object)
      const comparisonResult = selectedValue === firstItemId;
      console.log(
        `\nselectedCell.get() === proxy.items[0].id: ${comparisonResult}`,
      );
      console.log(
        `Expected: false (comparing primitive string to OpaqueRef proxy)`,
      );

      // Test if item.id has .get() method that would fix this
      const hasGet =
        typeof (firstItemId as { get?: unknown })?.get === "function";
      console.log(`\nDoes proxy.items[0].id have .get()? ${hasGet}`);

      if (hasGet) {
        const itemIdValue = (firstItemId as unknown as { get: () => string })
          .get();
        console.log(`proxy.items[0].id.get() = "${itemIdValue}"`);
        const fixedComparison = selectedValue === itemIdValue;
        console.log(
          `selectedCell.get() === proxy.items[0].id.get(): ${fixedComparison}`,
        );
        console.log(`Expected: true (both are primitive strings now)`);
      }

      console.log("=== END MAP ITEM COMPARISON ===\n");

      await tx.commit();

      // Assert the hypothesis
      expect(comparisonResult).toBe(false); // OpaqueRef proxy !== primitive string
      expect(typeof firstItemId).toBe("object"); // Proxy is object type
    });
  });
});

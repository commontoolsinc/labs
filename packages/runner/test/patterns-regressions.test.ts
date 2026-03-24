// Regression tests for specific bug fixes. Each test should reference
// the issue number (e.g. CT-1158). New regressions go here.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Regressions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let derive: ReturnType<typeof createBuilder>["commonfabric"]["derive"];
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let ifElse: ReturnType<typeof createBuilder>["commonfabric"]["ifElse"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commonfabric } = createBuilder();
    ({
      derive,
      pattern,
      ifElse,
    } = commonfabric);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should preserve cell references when map truncates with ifElse null values (CT-1158)", async () => {
    // Regression test for CT-1158: Map truncation was losing cell references
    // when ifElse returned null. The bug was in map.ts using .get().slice()
    // which dereferences cells, causing null values to lose their cell refs.
    //
    // Repro: Create a map with ifElse that returns null for some items,
    // then remove an item from the source array. The remaining items should
    // still be accessible (not undefined due to broken cell references).

    const testPattern = pattern<
      { items: Array<{ name: string; visible: boolean }> }
    >(
      ({ items }) => {
        // Map over items, returning item name if visible, null otherwise
        const mapped = items.map((item) =>
          ifElse(
            derive(item, (i) => i.visible),
            derive(item, (i) => i.name),
            null,
          )
        );
        return { items, mapped };
      },
    );

    const resultCell = runtime.getCell<{
      items: Array<{ name: string; visible: boolean }>;
      mapped: Array<string | null>;
    }>(
      space,
      "ct-1158-map-truncation",
      undefined,
      tx,
    );

    // Start with 3 items: A (visible), B (hidden), C (visible)
    const result = runtime.run(tx, testPattern, {
      items: [
        { name: "A", visible: true },
        { name: "B", visible: false },
        { name: "C", visible: true },
      ],
    }, resultCell);
    await tx.commit();

    await result.pull();

    // Verify initial state: ["A", null, "C"]
    const initialMapped = result.key("mapped").get();
    expect(initialMapped).toHaveLength(3);
    expect(initialMapped[0]).toBe("A");
    expect(initialMapped[1]).toBe(null);
    expect(initialMapped[2]).toBe("C");

    // Now remove the LAST item - this triggers map truncation from 3 to 2 items
    // The truncation should preserve cell refs for items[0] and items[1]
    tx = runtime.edit();
    const currentItems = result.withTx(tx).key("items").get();
    result.withTx(tx).key("items").set(currentItems.slice(0, 2)); // Keep first 2
    tx.commit();

    await result.pull();

    // After truncation, mapped should be ["A", null]
    // BUG (before fix): null at index 1 became a broken reference, entire array invalid
    // FIXED: Cell references preserved, mapped correctly shows ["A", null]
    const afterMapped = result.key("mapped").get();
    expect(afterMapped).toHaveLength(2);
    expect(afterMapped[0]).toBe("A"); // A was visible
    expect(afterMapped[1]).toBe(null); // B was hidden, null preserved correctly
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commontools/utils/equal-ignoring-symbols";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Frame Validation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let recipe: ReturnType<typeof createBuilder>["commontools"]["recipe"];
  let handler: ReturnType<typeof createBuilder>["commontools"]["handler"];
  let ifElse: ReturnType<typeof createBuilder>["commontools"]["ifElse"];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder(runtime);
    ({
      recipe,
      handler,
      ifElse,
    } = commontools);
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should allow handler closure over map iterator variable inside ifElse", async () => {
    // This test reproduces the bug from the Linear issue:
    // Handler closures inside .map() operations fail when wrapped in ifElse()
    // with error: "Accessing an opaque ref via closure is not supported"

    interface Item {
      id: string;
      value: number;
    }

    interface State {
      items: Item[];
      hasItems: boolean;
      counter: { count: number };
    }

    // Create a handler that accesses both outer state and map iterator variable
    const incrementItem = handler<
      unknown,
      { counter: { count: number }; item: Item }
    >(
      (_event, { counter, item }) => {
        counter.count += item.value;
      },
      { proxy: true },
    );

    // Create recipe that uses the pattern: ifElse -> map -> handler closure
    const testRecipe = recipe<State>(
      "IfElseMapHandler",
      (state) => {
        // Map over items - handler closures capture both state.counter and item
        const itemList = state.items.map((item) => {
          // Handler closure captures:
          // - state.counter from outer recipe scope
          // - item from map iterator (has runtime frame)
          // At runtime, ifElse creates new frame, map creates iterator frames
          // The fix allows this via frame ancestry check
          const stream = incrementItem({ counter: state.counter, item });
          return { itemId: item.id, stream };
        });

        return {
          result: ifElse(
            state.hasItems,
            itemList,
            [],
          ),
        };
      },
    );

    // Run the recipe - this will call connectInputAndOutputs and validate frames
    const resultCell = runtime.getCell<any>(
      space,
      "ifElse-map-handler-test",
      undefined,
      tx,
    );

    // This should NOT throw "Accessing an opaque ref via closure is not supported"
    // The frame ancestry check should allow access because:
    // - handler node's frame is the builder frame
    // - item's frame (from map) is a runtime frame that's a descendant of builder frame
    const result = runtime.run(tx, testRecipe, {
      items: [{ id: "item-1", value: 10 }, { id: "item-2", value: 20 }],
      hasItems: true,
      counter: { count: 0 },
    }, resultCell);

    await tx.commit();
    await runtime.idle();

    // Verify the recipe ran successfully
    const resultData = result.getAsQueryResult();
    expect(resultData).toBeDefined();
    expect(resultData.result).toBeDefined();
    expect(Array.isArray(resultData.result)).toBe(true);
    expect(resultData.result.length).toBe(2);
  });

  it("should allow handler closure over nested map iterator variables", async () => {
    // Additional test: nested maps with handler closures
    interface Item {
      id: string;
      value: number;
    }

    const incrementFromItem = handler<
      unknown,
      { counter: { count: number }; item: Item }
    >(
      (_event, { counter, item }) => {
        counter.count += item.value;
      },
      { proxy: true },
    );

    const testRecipe = recipe<{ groups: Item[][]; counter: { count: number } }>(
      "NestedMapHandler",
      (state) => {
        return {
          result: state.groups.map((group) => {
            return group.map((item) => {
              // Handler captures item from inner map iterator
              // and state.counter from outer scope
              const stream = incrementFromItem({
                counter: state.counter,
                item,
              });
              return { itemId: item.id, stream };
            });
          }),
        };
      },
    );

    const resultCell = runtime.getCell<any>(
      space,
      "nested-map-test",
      undefined,
      tx,
    );

    // Should not throw frame validation error
    const result = runtime.run(tx, testRecipe, {
      groups: [[{ id: "item-1", value: 5 }], [{ id: "item-2", value: 10 }]],
      counter: { count: 0 },
    }, resultCell);

    await tx.commit();
    await runtime.idle();

    const resultData = result.getAsQueryResult();
    expect(resultData).toBeDefined();
    expect(resultData.result).toBeDefined();
    expect(Array.isArray(resultData.result)).toBe(true);
    expect(resultData.result.length).toBe(2);
    expect(Array.isArray(resultData.result[0])).toBe(true);
  });
});

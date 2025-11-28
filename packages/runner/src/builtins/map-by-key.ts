import { type JSONSchema, type Recipe } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * Implementation of mapByKey built-in module.
 *
 * Unlike map() which tracks by index, mapByKey() tracks by key.
 * This means:
 * - Reordering the input array doesn't cause re-processing
 * - Same key = same result cell, regardless of position
 * - Automatic deduplication (duplicate keys use first occurrence)
 *
 * Key extraction:
 * - If keyPath is undefined, the item value itself is used as the key
 * - If keyPath is a string like "id", item.id is used
 * - If keyPath is an array like ["nested", "id"], item.nested.id is used
 *
 * This is critical for streaming pipelines where derived arrays may reorder
 * without wanting to trigger recomputation.
 *
 * @param list - Array of values to map over
 * @param keyPath - Property path to extract key (string, string[], or undefined for identity)
 * @param op - Recipe to apply to each value
 * @param params - Optional captured variables from outer scope
 */
export function mapByKey(
  inputsCell: Cell<{
    list: any[];
    keyPath?: string | string[];
    op: Recipe;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let result: Cell<any[]> | undefined;

  // Track key → result cell mapping across invocations
  // This persists between scheduler runs to reuse existing result cells
  const keyToResultCell = new Map<string, Cell<any>>();

  return (tx: IExtendedStorageTransaction) => {
    // Create result array cell once
    if (!result) {
      result = runtime.getCell<any[]>(
        parentCell.space,
        {
          mapByKey: parentCell.entityId,
          op: inputsCell.getAsQueryResult([], tx)?.op,
          cause,
        },
        undefined,
        tx,
      );
      result.send([]);
      result.setSourceCell(parentCell);
      sendResult(tx, result);
    }

    const resultWithTx = result.withTx(tx);

    // Get inputs with items as Cells for passing to recipe
    const { list, keyPath, op, params } = inputsCell.asSchema(
      {
        type: "object",
        properties: {
          list: { type: "array", items: { asCell: true } },
          keyPath: {}, // Can be string, string[], or undefined
          op: { asCell: true },
          params: { type: "object" },
        },
        required: ["list", "op"],
        additionalProperties: false,
      } as const satisfies JSONSchema,
    ).withTx(tx).get();

    // .getRaw() because we want the recipe itself
    const opRecipe = op?.getRaw();

    // If result is undefined, initialize to empty array
    if (resultWithTx.get() === undefined) {
      resultWithTx.set([]);
    }

    // Handle undefined/empty list
    if (list === undefined || !Array.isArray(list)) {
      resultWithTx.set([]);
      return;
    }

    if (!opRecipe) {
      console.error("mapByKey: op recipe is required");
      resultWithTx.set([]);
      return;
    }

    /**
     * Extract key from an item using keyPath
     */
    function extractKey(itemValue: any): any {
      if (keyPath === undefined) {
        // Identity: use item value as key
        return itemValue;
      }

      if (typeof keyPath === "string") {
        // Single property path
        return itemValue?.[keyPath];
      }

      if (Array.isArray(keyPath)) {
        // Nested property path
        let value = itemValue;
        for (const segment of keyPath) {
          if (value === undefined || value === null) return undefined;
          value = value[segment];
        }
        return value;
      }

      return itemValue;
    }

    const resultArray: Cell<any>[] = [];
    const seenKeys = new Set<string>();

    for (let i = 0; i < list.length; i++) {
      const itemCell = list[i] as Cell<any>;

      // Extract key from item value
      let key: any;
      try {
        const itemValue = itemCell.withTx(tx).get();
        key = extractKey(itemValue);
      } catch (e) {
        console.warn("mapByKey: key extraction failed, using index", e);
        key = i;
      }

      // Serialize key for Map lookup
      const keyString = JSON.stringify(key);

      // Skip duplicate keys (first wins)
      if (seenKeys.has(keyString)) {
        continue;
      }
      seenKeys.add(keyString);

      // Check if we already have a result cell for this key
      let resultCell = keyToResultCell.get(keyString);

      if (!resultCell) {
        // Create NEW result cell with KEY-based identity
        // This is the critical difference from map.ts!
        // NOTE: Use keyString (serialized key) for entity ID because
        // runtime.getCell() doesn't correctly hash complex objects.
        // Using the raw key object causes all items to get the same entityId.
        resultCell = runtime.getCell(
          parentCell.space,
          { result, keyString }, // ← Use serialized key for correct hashing
          undefined,
          tx,
        );

        // Determine recipe inputs based on presence of params
        const recipeInputs = params !== undefined
          ? {
              // Closure mode: include params
              element: inputsCell.key("list").key(i),
              key,
              index: i,
              array: inputsCell.key("list"),
              params: inputsCell.key("params"),
            }
          : {
              // Legacy mode: no params
              element: inputsCell.key("list").key(i),
              key,
              index: i,
              array: inputsCell.key("list"),
            };

        // Run the recipe for this item
        runtime.runner.run(
          tx,
          opRecipe,
          recipeInputs,
          resultCell,
        );

        resultCell.getSourceCell()?.setSourceCell(parentCell);

        // Add cancel callback
        addCancel(() => runtime.runner.stop(resultCell!));

        keyToResultCell.set(keyString, resultCell);
      }

      resultArray.push(resultCell);
    }

    // Update result array (maintains key-based cells in current order)
    resultWithTx.set(resultArray);

    // Cleanup: stop and remove result cells for keys no longer in list
    for (const [keyString, cell] of keyToResultCell) {
      if (!seenKeys.has(keyString)) {
        runtime.runner.stop(cell);
        keyToResultCell.delete(keyString);
      }
    }
  };
}

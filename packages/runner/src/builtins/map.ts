import { type JSONSchema, type Pattern } from "../builder/types.ts";

import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { addressKey } from "../link-types.ts";

/**
 * Implementation of built-in map module. Unlike regular modules, this will be
 * called once at setup and thus sets up its own actions for the scheduler.
 *
 * This supports both legacy map calls and closure-transformed map calls:
 * - Legacy mode (params === undefined): Passes { element, index, array } to pattern
 * - Closure mode (params !== undefined): Passes { element, index, array, params } to pattern
 *
 * The goal is to keep the output array current without recomputing too much.
 *
 * Elements are tracked by the normalized link address of their cell (via
 * `getAsNormalizedFullLink()`). The `asSchema` traverse with `asCell: true`
 * already resolves cell links to target entities, so:
 *
 * - Cell links: `list[i]` resolves to a cell pointing at the target entity.
 *   Its normalized link is stable across position changes, enabling reuse.
 * - Inline values: `list[i]` resolves to a cell pointing at the array position.
 *   Its normalized link includes the positional index, so identity = position.
 *   Shifted inline values get new runs (acceptable trade-off).
 *
 * @param list - A doc containing an array of values to map over.
 * @param op - A pattern to apply to each value.
 * @param params - Optional object containing captured variables from outer scope (closure mode).
 * @returns A doc containing the mapped values.
 */
export function map(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
): Action {
  let result: Cell<any[]> | undefined;

  // Identity-based tracking: maps element address key → { resultCell, lastIndex }
  // for reuse across position changes. We pass list[i] directly each time, so
  // there's no need to store the element cell separately.
  const elementRuns = new Map<
    string,
    { resultCell: Cell<any>; lastIndex: number }
  >();

  return (tx: IExtendedStorageTransaction) => {
    if (!result) {
      result = runtime.getCell<any[]>(
        parentCell.space,
        {
          map: parentCell.entityId,
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
    const resultWithLog = result.withTx(tx);
    const { list, op } = inputsCell.asSchema(
      {
        type: "object",
        properties: {
          // type: "unknown" is ignored by the asCell code path (no type validation)
          list: { type: "array", items: { asCell: true, type: "unknown" } },
          op: { asCell: true },
        },
        required: ["op"],
      } as const satisfies JSONSchema,
    ).withTx(tx).get();

    // .getRaw() because we want the pattern itself and avoid following the
    // aliases in the pattern
    const opPattern = op.getRaw();

    // If the result's value is undefined, set it to the empty array.
    if (resultWithLog.get() === undefined) {
      resultWithLog.set([]);
    }
    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      resultWithLog.set([]);
      elementRuns.clear();
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("map currently only supports arrays");
    }

    const keyCounts = new Map<string, number>();
    const newArrayValue: any[] = [];
    for (let i = 0; i < list.length; i++) {
      const link = list[i].getAsNormalizedFullLink();
      const baseKey = addressKey(link);
      const occurrence = keyCounts.get(baseKey) ?? 0;
      keyCounts.set(baseKey, occurrence + 1);
      const elementKey = JSON.stringify([
        link.space,
        link.id,
        link.type,
        link.path,
        occurrence,
      ]);

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        if (existing.lastIndex !== i) {
          runtime.runner.run(
            tx,
            opPattern,
            {
              element: list[i],
              index: i,
              array: inputsCell.key("list"),
              params: inputsCell.key("params"),
            },
            existing.resultCell,
            { doNotUpdateOnPatternChange: true },
          );
          existing.lastIndex = i;
        }
        resultWithLog.key(i).set(existing.resultCell);
        newArrayValue.push(existing.resultCell);
      } else {
        const resultCell = runtime.getCell(
          parentCell.space,
          { result, elementKey },
          undefined,
          tx,
        );
        runtime.runner.run(
          tx,
          opPattern,
          {
            element: list[i],
            index: i,
            array: inputsCell.key("list"),
            params: inputsCell.key("params"),
          },
          resultCell,
          { doNotUpdateOnPatternChange: true },
        );
        resultCell.getSourceCell()!.setSourceCell(parentCell);
        addCancel(() => runtime.runner.stop(resultCell));
        elementRuns.set(elementKey, { resultCell, lastIndex: i });
        resultWithLog.key(i).set(resultCell);
        newArrayValue.push(resultCell);
      }
    }

    // Update result array length if it changed
    const currentResult = resultWithLog.get();
    if (currentResult.length > list.length) {
      // Use getRaw() to preserve cell references. Using .get() would dereference
      // cells to their values, losing the reference when the value is null.
      const rawResult = resultWithLog.getRaw() ?? currentResult;
      resultWithLog.set(rawResult.slice(0, list.length));
    } else if (currentResult.length < list.length) {
      resultWithLog.set(newArrayValue);
    }

    // NOTE: We leave prior results in elementRuns for now, so they reuse
    // prior runs when items reappear. This means elementRuns grows
    // unboundedly when elements are removed — the runner is stopped via
    // addCancel when the parent is disposed, but the Map entries (and their
    // resultCell references) are not pruned. TODO: Consider pruning entries
    // not present in the current list if this becomes a problem for
    // long-lived maps with high element churn.
  };
}

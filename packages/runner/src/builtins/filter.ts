import { type JSONSchema, type Pattern } from "../builder/types.ts";

import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * Implementation of built-in filter module. Like map, this is called once at
 * setup and manages its own actions for the scheduler.
 *
 * Runs a predicate pattern per element. The output array contains cell
 * references to the original input elements where the predicate is truthy.
 * Output is always dense (no holes), even when the input is sparse.
 *
 * Identity tracking and reconciliation are identical to map — see map.ts for
 * the full explanation of how getAsNormalizedFullLink() provides stable
 * identity for cell links and positional identity for inline values.
 *
 * Two-pass convergence: when a new element appears, its predicate pattern
 * hasn't run yet, so the predicate cell is undefined and the element is
 * excluded. The predicate then runs, updating its cell, which re-triggers
 * this action. On the second pass the element is correctly included or
 * excluded.
 */
export function filter(
  inputsCell: Cell<{
    list: any[];
    op: Pattern;
    params?: Record<string, any>;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  let result: Cell<any[]> | undefined;

  // Identity-based tracking: maps element address key → { resultCell, lastIndex }
  // resultCell holds the predicate boolean for this element.
  const elementRuns = new Map<
    string,
    { resultCell: Cell<any>; lastIndex: number }
  >();

  return (tx: IExtendedStorageTransaction) => {
    if (!result) {
      result = runtime.getCell<any[]>(
        parentCell.space,
        {
          filter: parentCell.entityId,
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
          list: { type: "array", items: { asCell: true, type: "unknown" } },
          op: { asCell: true },
        },
        required: ["op"],
      } as const satisfies JSONSchema,
    ).withTx(tx).get();

    const opPattern = op.getRaw();

    if (resultWithLog.get() === undefined) {
      resultWithLog.set([]);
    }
    if (list === undefined) {
      resultWithLog.set([]);
      elementRuns.clear();
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("filter currently only supports arrays");
    }

    const keyCounts = new Map<string, number>();
    const newArrayValue: any[] = [];
    for (let i = 0; i < list.length; i++) {
      // Skip sparse holes — don't create predicate runs for them
      if (!(i in list)) continue;

      const { space: s, id, type, path } = list[i].getAsNormalizedFullLink();
      const dedupKey = JSON.stringify([s, id, type, path]);
      const occurrence = keyCounts.get(dedupKey) ?? 0;
      keyCounts.set(dedupKey, occurrence + 1);
      const elementKey = JSON.stringify([s, id, type, path, occurrence]);

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
      } else {
        const resultCell = runtime.getCell(
          parentCell.space,
          { filter: result, elementKey },
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
      }

      // Read predicate result — creates subscription for reactivity.
      // Truthy/falsy coercion, not strict boolean.
      const included = elementRuns.get(elementKey)!.resultCell.withTx(tx).get();
      if (included) {
        newArrayValue.push(list[i]); // Original element cell reference
      }
    }
    resultWithLog.set(newArrayValue);

    // NOTE: Same as map — elementRuns is not pruned. See map.ts for rationale.
  };
}

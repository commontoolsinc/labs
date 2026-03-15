import type { JSONSchema, Pattern } from "../builder/types.ts";

import type { Cell } from "../cell.ts";
import type { Action } from "../scheduler.ts";
import type { AddCancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { inferListOpArgumentUsage } from "./list-op-argument-usage.ts";

/**
 * Implementation of built-in flatMap module. Like map, this is called once at
 * setup and manages its own actions for the scheduler.
 *
 * Runs a pattern per element. If the result is an array, it is spread into
 * the output (one level deep, consistent with Array.prototype.flatMap). If
 * the result is a scalar, it is included directly. undefined results are
 * skipped (see two-pass convergence below). Output is always dense.
 *
 * Sub-arrays are iterated with forEach, which skips holes — so sparse
 * per-element results are densified during flattening.
 *
 * Identity tracking and reconciliation are identical to map — see map.ts for
 * the full explanation.
 *
 * Two-pass convergence: same as filter. When a new element appears, its
 * pattern hasn't run yet, so the result cell is undefined and the element
 * contributes nothing to the output. The pattern then runs, updating its
 * cell, which re-triggers this action.
 */
export function flatMap(
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
  // resultCell holds the per-element result array.
  const elementRuns = new Map<
    string,
    { resultCell: Cell<any>; lastIndex: number }
  >();

  return (tx: IExtendedStorageTransaction) => {
    if (!result) {
      result = runtime.getCell<any[]>(
        parentCell.space,
        {
          flatMap: parentCell.entityId,
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
    const argumentUsage = inferListOpArgumentUsage(runtime.cfc, opPattern);
    const createRunInput = (element: Cell<any>, index: number) => ({
      ...(argumentUsage.usesElement ? { element } : {}),
      ...(argumentUsage.usesIndex ? { index } : {}),
      ...(argumentUsage.usesArray ? { array: inputsCell.key("list") } : {}),
      ...(argumentUsage.usesParams ? { params: inputsCell.key("params") } : {}),
    });

    if (resultWithLog.get() === undefined) {
      resultWithLog.set([]);
    }
    if (list === undefined) {
      resultWithLog.set([]);
      for (const entry of elementRuns.values()) {
        runtime.runner.stop(entry.resultCell);
      }
      elementRuns.clear();
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("flatMap currently only supports arrays");
    }

    const keyCounts = new Map<string, number>();
    const newArrayValue: any[] = [];
    for (let i = 0; i < list.length; i++) {
      // Skip sparse holes — don't create pattern runs for them
      if (!(i in list)) continue;

      const { space: s, id, type, path } = list[i].getAsNormalizedFullLink();
      const dedupKey = JSON.stringify([s, id, type, path]);
      const occurrence = keyCounts.get(dedupKey) ?? 0;
      keyCounts.set(dedupKey, occurrence + 1);
      const elementKey = JSON.stringify([s, id, type, path, occurrence]);

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        if (argumentUsage.usesIndex && existing.lastIndex !== i) {
          runtime.runner.run(
            tx,
            opPattern,
            createRunInput(list[i], i),
            existing.resultCell,
            { doNotUpdateOnPatternChange: true },
          );
        }
        existing.lastIndex = i;
      } else {
        const resultCell = runtime.getCell(
          parentCell.space,
          { flatMap: result, elementKey },
          undefined,
          tx,
        );
        runtime.runner.run(
          tx,
          opPattern,
          createRunInput(list[i], i),
          resultCell,
          { doNotUpdateOnPatternChange: true },
        );
        resultCell.getSourceCell()!.setSourceCell(parentCell);
        addCancel(() => runtime.runner.stop(resultCell));
        elementRuns.set(elementKey, { resultCell, lastIndex: i });
      }

      // Read per-element result and flatten one level into output.
      // Matches JS flatMap semantics: arrays are spread, scalars are included
      // directly. undefined is skipped (two-pass convergence: new elements
      // have undefined result cells on the first pass before the pattern runs).
      const elemResult = elementRuns.get(elementKey)!.resultCell.withTx(tx)
        .get();
      if (Array.isArray(elemResult)) {
        // forEach skips holes in sub-arrays (sparse-safe)
        elemResult.forEach((v) => {
          newArrayValue.push(v);
        });
      } else if (elemResult !== undefined) {
        newArrayValue.push(elemResult);
      }
    }
    resultWithLog.set(newArrayValue);

    // NOTE: Same as map — elementRuns is not pruned. See map.ts for rationale.
  };
}

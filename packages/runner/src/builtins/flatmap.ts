import type { Pattern } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";

const FLATMAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

import type { Cell } from "../cell.ts";
import type { Action } from "../scheduler.ts";
import type { AddCancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { listResultSchema } from "./list-result-schema.ts";
import { inferListOpArgumentUsage } from "./list-op-argument-usage.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import {
  cellIdentityKey,
  narrowestCellScope,
  outputSpotFromBinding,
  scopedCell,
} from "./scope-policy.ts";
import { resolveOpPattern } from "./op-pattern-ref.ts";

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
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
): Action {
  let result: Cell<any[]> | undefined;

  // Identity-based tracking: maps element address key → { resultCell, lastIndex }
  // resultCell holds the per-element result array.
  const elementRuns = new Map<
    string,
    { resultCell: Cell<any>; lastIndex: number }
  >();

  return (tx: IExtendedStorageTransaction) => {
    const { list, op } = inputsCell.asSchema(FLATMAP_INPUT_SCHEMA)
      .withTx(tx).get();

    const opPattern = resolveOpPattern(runtime, op.getRaw(), "flatMap");
    const argumentUsage = inferListOpArgumentUsage(runtime.cfc, opPattern);
    const outputScope = narrowestCellScope(runtime, tx, [
      inputsCell.key("list"),
      ...(Array.isArray(list) && argumentUsage.usesElement ? list : []),
      argumentUsage.usesArray ? inputsCell.key("list") : undefined,
      argumentUsage.usesParams ? inputsCell.key("params") : undefined,
    ]);

    if (!result || result.getAsNormalizedFullLink().scope !== outputScope) {
      const resultSchema = listResultSchema();
      // CT-1623: identify the result container by the reserved output spot
      // (stable, program-independent). See map.ts for rationale.
      const outputSpot = outputSpotFromBinding(outputBinding);
      if (!outputSpot) {
        throw new Error(
          "flatMap: result container requires a write-redirect output binding",
        );
      }
      const baseResult = runtime.getCell<any[]>(
        parentCell.space,
        { flatMap: parentCell.entityId, outputSpot },
        resultSchema,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);
      result.send([]);
      // Link this cell to the parent cell
      setResultCell(result, parentCell);
      // Link the new result cells to the pattern cell too
      setPatternCell(result, parentCell.key("pattern"));
      sendResult(tx, result);
    }
    const resultWithLog = result.withTx(tx);
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

      const { dedupKey, linkKey } = cellIdentityKey(list[i]);
      const occurrence = keyCounts.get(dedupKey) ?? 0;
      keyCounts.set(dedupKey, occurrence + 1);
      const elementKey = JSON.stringify([...linkKey, occurrence]);

      if (elementRuns.has(elementKey)) {
        const existing = elementRuns.get(elementKey)!;
        if (argumentUsage.usesIndex && existing.lastIndex !== i) {
          runtime.runner.run(
            tx,
            opPattern,
            createRunInput(list[i], i),
            existing.resultCell,
            {
              doNotUpdateOnPatternChange: true,
            },
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
          {
            doNotUpdateOnPatternChange: true,
          },
        );
        // Link the new result cells to the pattern cell too
        setPatternCell(resultCell, parentCell.key("pattern"));
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

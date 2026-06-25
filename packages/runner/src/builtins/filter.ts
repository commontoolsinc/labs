import type { Pattern } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";

// Presence probe for the result container: slots resolve as cells, so the
// coordinator can ask "is the container initialized?" without materializing
// element contents. A content-schema get() here would journal real value
// reads of every element result — under flow labels (S16) that smears every
// element's taint into the coordinator's per-tx join and from there onto
// sibling scaffolding (the read-own-output feedback).
const RESULT_PRESENCE_SCHEMA = internSchema({
  type: "array",
  items: { asCell: ["cell"], type: "unknown" },
});

const FILTER_INPUT_SCHEMA = internSchema({
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
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
  awaitSync?: boolean,
): Action {
  let result: Cell<any[]> | undefined;

  // Identity-based tracking: maps element address key → { resultCell, lastIndex }
  // resultCell holds the predicate boolean for this element.
  const elementRuns = new Map<
    string,
    { resultCell: Cell<any>; lastIndex: number }
  >();

  // Only the initial (resume) reconcile defers its per-element sub-pattern runs
  // until sync completes; elements from later (post-resume) reconciles are fresh
  // and must not wait. Cleared once a non-empty resume batch is processed.
  let resumeBatchAwaitSync = !!awaitSync;

  return (tx: IExtendedStorageTransaction) => {
    const elementAwaitSync = resumeBatchAwaitSync;
    const { list, op } = inputsCell.asSchema(FILTER_INPUT_SCHEMA)
      .withTx(tx).get();

    const opPattern = resolveOpPattern(runtime, op.getRaw(), "filter");
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
          "filter: result container requires a write-redirect output binding",
        );
      }
      const baseResult = runtime.getCell<any[]>(
        parentCell.space,
        { filter: parentCell.entityId, outputSpot },
        resultSchema,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, outputScope);
      // Link this cell to the parent cell
      setResultCell(result, parentCell);
      // Link the new result cells to the pattern cell too
      setPatternCell(result, parentCell.key("pattern"));
      sendResult(tx, result);
    }
    // The coordinator's view of the result container is links-only
    // (RESULT_PRESENCE_SCHEMA): get() probes presence and set() diffs
    // prior slots as links, never materializing element contents. A
    // content-schema view here journals value reads of every element
    // result on each reconcile — under flow labels (S16) that smears
    // every element's taint into the coordinator's per-tx join.
    const resultWithLog = result.asSchema(RESULT_PRESENCE_SCHEMA)
      .withTx(tx);
    const createRunInput = (element: Cell<any>, index: number) => ({
      ...(argumentUsage.usesElement ? { element } : {}),
      ...(argumentUsage.usesIndex ? { index } : {}),
      ...(argumentUsage.usesArray ? { array: inputsCell.key("list") } : {}),
      ...(argumentUsage.usesParams ? { params: inputsCell.key("params") } : {}),
    });

    const existingResult = resultWithLog.get();
    const preserveResumeResult = elementAwaitSync &&
      Array.isArray(existingResult) &&
      existingResult.length > 0;
    if (existingResult === undefined) {
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
      throw new Error("filter currently only supports arrays");
    }

    const keyCounts = new Map<string, number>();
    const newArrayValue: any[] = [];
    let hasPendingPredicate = false;
    for (let i = 0; i < list.length; i++) {
      // Skip sparse holes — don't create predicate runs for them
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
              awaitSyncBeforeInitialRun: elementAwaitSync,
            },
          );
        }
        existing.lastIndex = i;
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
          createRunInput(list[i], i),
          resultCell,
          {
            doNotUpdateOnPatternChange: true,
            awaitSyncBeforeInitialRun: elementAwaitSync,
          },
        );
        // Link these individual cells to the top cell
        setResultCell(resultCell, parentCell);
        // Link the new result cells to the pattern cell too
        setPatternCell(resultCell, parentCell.key("pattern"));

        addCancel(() => runtime.runner.stop(resultCell));
        elementRuns.set(elementKey, { resultCell, lastIndex: i });
      }

      // Read predicate result — creates subscription for reactivity.
      // Truthy/falsy coercion, not strict boolean.
      const included = elementRuns.get(elementKey)!.resultCell.withTx(tx).get();
      if (included === undefined) {
        hasPendingPredicate = true;
      }
      if (included) {
        newArrayValue.push(list[i]); // Original element cell reference
      }
    }
    if (preserveResumeResult && hasPendingPredicate) return;
    resumeBatchAwaitSync = false;
    resultWithLog.set(newArrayValue);

    // NOTE: Same as map — elementRuns is not pruned. See map.ts for rationale.
  };
}

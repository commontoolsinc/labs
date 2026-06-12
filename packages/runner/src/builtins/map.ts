import { type Pattern } from "../builder/types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";

const MAP_INPUT_SCHEMA = internSchema({
  type: "object",
  properties: {
    // `processDefaultValue()` treats `asCell` as an opaque cell boundary, so
    // `type: "unknown"` only documents the inner value shape here.
    list: { type: "array", items: { asCell: ["cell"], type: "unknown" } },
    op: { asCell: ["cell"] },
  },
  required: ["op"],
});

const MAP_LIST_SCHEMA = internSchema({
  type: "array",
  // `processDefaultValue()` treats `asCell` as an opaque cell boundary, so
  // `type: "unknown"` only documents the inner value shape here.
  items: { asCell: ["cell"], type: "unknown" },
});

import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { outputSpotFromBinding } from "./scope-policy.ts";
import { listResultSchema } from "./list-result-schema.ts";
import { inferListOpArgumentUsage } from "./list-op-argument-usage.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import {
  cellIdentityKey,
  exposedResultCell,
  scopedCell,
} from "./scope-policy.ts";
import { resolveLink } from "../link-resolution.ts";
import { resolveOpPattern } from "./op-pattern-ref.ts";

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
 * `getAsNormalizedFullLink()`). The `asSchema` traverse with
 * `asCell: ["cell"]` already resolves cell links to target entities, so:
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
  _cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
  outputBinding?: NormalizedFullLink,
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
    const mappedInputs = inputsCell.asSchema(MAP_INPUT_SCHEMA).withTx(tx);
    const op = mappedInputs.key("op").get();
    const sourceListCell = inputsCell.key("list");
    const listTarget = resolveLink(
      runtime,
      tx,
      sourceListCell.getAsNormalizedFullLink(),
      "writeRedirect",
    );
    const listScope = listTarget.scope;
    // `array` callback arguments should observe the actual list entity, not the
    // alias/boxed reference used to pass that list into the builtin.
    const listCell = sourceListCell.withTx(tx).resolveAsCell();
    const list = listCell.asSchema(MAP_LIST_SCHEMA).withTx(tx).get();
    // .getRaw() because we want the pattern itself and avoid following the
    // aliases in the pattern. The raw value is either a compact
    // `{ $patternRef }` sentinel (resolved to the live canonical pattern by
    // identity) or, on the legacy path, the embedded pattern graph itself.
    const opPattern = resolveOpPattern(runtime, op.getRaw(), "map");
    const argumentUsage = inferListOpArgumentUsage(runtime.cfc, opPattern);

    if (!result || result.getAsNormalizedFullLink().scope !== listScope) {
      const resultSchema = listResultSchema(opPattern.resultSchema);
      // CT-1623: identify the result container by the reserved output spot —
      // the fully-resolved write-redirect target the runner supplies as the
      // `outputBinding`. It is a stable, position-derived, program-independent
      // identity, unlike the serialized `op` / inputs, both of which drag in the
      // session-varying `program` and force the container id (and every per-row
      // id derived from it) to churn across reloads. A `map` node always writes
      // through a write redirect, so the absence of an output spot is a bug.
      const outputSpot = outputSpotFromBinding(outputBinding);
      if (!outputSpot) {
        throw new Error(
          "map: result container requires a write-redirect output binding",
        );
      }
      const baseResult = runtime.getCell<any[]>(
        parentCell.space,
        { map: parentCell.entityId, outputSpot },
        resultSchema,
        tx,
      );
      result = scopedCell(runtime, tx, baseResult, listScope);
      result.send([]);
      setResultCell(result, parentCell);
      // Link the new result cells to the pattern cell too
      setPatternCell(result, parentCell.key("pattern"));
      sendResult(tx, result);
    }
    const resultWithLog = result.withTx(tx);

    const createRunInput = (element: Cell<any>, index: number) => ({
      ...(argumentUsage.usesElement ? { element } : {}),
      ...(argumentUsage.usesIndex ? { index } : {}),
      ...(argumentUsage.usesArray ? { array: listCell } : {}),
      ...(argumentUsage.usesParams ? { params: inputsCell.key("params") } : {}),
    });

    // If the result's value is undefined, set it to the empty array.
    if (resultWithLog.get() === undefined) {
      resultWithLog.set([]);
    }
    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      resultWithLog.set([]);
      for (const entry of elementRuns.values()) {
        runtime.runner.stop(entry.resultCell);
      }
      elementRuns.clear();
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("map currently only supports arrays");
    }

    const keyCounts = new Map<string, number>();
    const newArrayValue = new Array<any>(list.length);
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
        newArrayValue[i] = exposedResultCell(runtime, tx, existing.resultCell);
      } else {
        const resultCell = runtime.getCell(
          parentCell.space,
          { map: result, elementKey },
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
        // Link these individual cells to the top cell
        setResultCell(resultCell, parentCell);
        // Link the new result cells to the pattern cell too
        setPatternCell(resultCell, parentCell.key("pattern"));
        addCancel(() => runtime.runner.stop(resultCell));
        elementRuns.set(elementKey, { resultCell, lastIndex: i });
        newArrayValue[i] = exposedResultCell(runtime, tx, resultCell);
      }
    }
    resultWithLog.set(newArrayValue);

    // NOTE: We leave prior results in elementRuns for now, so they reuse
    // prior runs when items reappear. This means elementRuns grows
    // unboundedly when elements are removed — the runner is stopped via
    // addCancel when the parent is disposed, but the Map entries (and their
    // resultCell references) are not pruned. TODO: Consider pruning entries
    // not present in the current list if this becomes a problem for
    // long-lived maps with high element churn.
  };
}

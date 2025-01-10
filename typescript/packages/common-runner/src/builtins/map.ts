import { type Recipe } from "@commontools/common-builder";
import {
  cell,
  CellImpl,
  ReactivityLog,
  getCellReferenceOrThrow,
} from "../cell.js";
import { run, cancels } from "../runner.js";
import { type Action } from "../scheduler.js";
import { type AddCancel } from "../cancel.js";

/**
 * Implemention of built-in map module. Unlike regular modules, this will be
 * called once at setup and thus sets up its own actions for the scheduler.
 *
 * The goal is to keep the output array current without recomputing too much.
 *
 * Approach:
 * 1. Create a cell to store the result.
 * 2. Create a handler to update the result cell when the input cell changes.
 * 3. Create a handler to update the result cell when the op cell changes.
 * 4. For each value in the input cell, create a handler to update the result
 *    cell when the value changes.
 *
 * TODO: Optimization depends on javascript objects and not lookslike objects.
 * We should make sure updates to arrays don't unnecessarily re-ify objects
 * and/or change the comparision here.
 *
 * @param list - A cell containing an array of values to map over.
 * @param op - A recipe to apply to each value.
 * @returns A cell containing the mapped values.
 */
export function map(
  inputsCell: CellImpl<{
    list: any[];
    op: Recipe;
  }>,
  sendResult: (result: any) => void,
  addCancel: AddCancel,
  cause: any,
  parentCell: CellImpl<any>,
): Action {
  const result = cell<any[]>([]);
  result.generateEntityId({
    map: parentCell.entityId,
    op: inputsCell.getAsQueryResult([])?.op,
    cause,
  });
  result.sourceCell = parentCell;

  sendResult({ cell: result, path: [] });

  return (log: ReactivityLog) => {
    let { list, op } = inputsCell.getAsQueryResult([], log);

    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      result.setAtPath([], [], log);
      return;
    }

    if (!Array.isArray(list))
      throw new Error("map currently only supports arrays");

    // // Hack to get to underlying array that lists cell references, etc.
    const listRef = getCellReferenceOrThrow(list);

    // Same for op, but here it's so that the proxy doesn't follow the aliases
    // in the recipe instead of returning the recipe.
    // TODO: Instead we should reify the recipe as a NodeFactory and teach the
    // query result proxy to not enter those.
    const opRef = getCellReferenceOrThrow(op);
    op = opRef.cell.getAtPath(opRef.path);

    // Update values that are new or have changed
    for (let index = result.get().length; index < list.length; index++) {

      const resultCell = cell();
      resultCell.generateEntityId({ result, index });
      run(op, { element: { cell: listRef.cell, path: [...listRef.path, index] }, index, array: list }, resultCell);
      resultCell.sourceCell!.sourceCell = parentCell;

      // TODO: Have `run` return cancel, once we make resultCell required
      addCancel(cancels.get(resultCell));

      // Send the result value to the result cell
      result.setAtPath([index], { cell: resultCell, path: [] }, log);
    }

    if (result.get().length > list.length)
      result.setAtPath(["length"], list.length, log);

    // NOTE: We leave prior results in the list for now, so they reuse prior
    // runs when items reappear
    //
    // Remove values that are no longer in the input sourceRefToResult =
    // sourceRefToResult.filter(({ ref }) => seen.find((seenValue) =>
    // isEqualCellReferences(seenValue, ref))
    //);
  };
}

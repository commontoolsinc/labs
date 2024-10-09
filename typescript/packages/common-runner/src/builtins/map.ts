import { type Recipe } from "@commontools/common-builder";
import {
  cell,
  CellImpl,
  ReactivityLog,
  getCellReferenceOrThrow,
  isCellReference,
  isCell,
  type CellReference,
} from "../cell.js";
import { run, cancels } from "../runner.js";
import { isEqualCellReferences, followCellReferences } from "../utils.js";
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
  addCancel: AddCancel
): Action {
  const result = cell<any[]>([]);
  let sourceRefToResult: { ref: CellReference; resultCell: CellImpl<any> }[] =
    [];

  sendResult(result);

  return (log: ReactivityLog) => {
    let { list, op } = inputsCell.getAsProxy([], log);

    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      result.setAtPath([], [], log);
      return;
    }

    if (!Array.isArray(list))
      throw new Error("map currently only supports arrays");

    // Hack to get to underlying array that lists cell references, etc.
    const listRef = getCellReferenceOrThrow(list);
    list = listRef.cell.getAtPath(listRef.path);

    const seen: any[] = [];

    // Update values that are new or have changed
    for (let index = 0; index < list.length; index++) {
      let value = list[index];

      // We have to manually add read logs, as we don't go via the proxy here.
      log?.reads.push({ cell: listRef.cell, path: [...listRef.path, index] });

      if (value === undefined) {
        result.setAtPath([index], undefined, log);
        continue;
      }

      if (isCell(value)) value = { cell: value, path: [] };
      if (!isCellReference(value))
        throw new Error("map requires all values to be cell references");

      // TODO: Replace with something that follows aliases as well.
      value = followCellReferences(value, log);

      if (typeof value !== "object")
        throw new Error("map currently only supports objects");

      // If the value is new, instantiate the recipe and store the result cell
      let itemResult = sourceRefToResult.find(({ ref }) =>
        isEqualCellReferences(ref, value)
      );

      if (!itemResult) {
        if (value.cell.getAtPath(value.path) === undefined) {
          // If value is undefined, don't yet insert the item. Add to read log,
          // so we get invoked again once it changes.
          log?.reads.push(value);
          continue;
        }
        const resultCell = run(op, value);
        addCancel(cancels.get(resultCell));
        itemResult = { ref: value, resultCell };
        sourceRefToResult.push(itemResult);
      }

      // Send the result value to the result cell
      result.setAtPath([index], { cell: itemResult.resultCell, path: [] }, log);
      seen.push(value);
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

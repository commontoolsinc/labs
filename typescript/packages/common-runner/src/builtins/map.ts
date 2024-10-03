import { type Recipe, type Node } from "@commontools/common-builder";
import {
  cell,
  CellImpl,
  ReactivityLog,
  getCellReferenceOrThrow,
  isCellReference,
  isCellProxy,
  type CellReference,
} from "../cell.js";
import { run } from "../runner.js";
import {
  sendValueToBinding,
  findAllAliasedCells,
  isEqualCellReferences,
  followCellReferences,
} from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { mapBindingsToCell } from "../utils.js";

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
export function map(recipeCell: CellImpl<any>, { inputs, outputs }: Node) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    list: any[];
    op: Recipe;
  };
  const outputBindings = mapBindingsToCell(outputs, recipeCell) as any[];

  const inputsCell = cell(inputBindings);
  const result = cell<any[] | undefined>(undefined);
  let sourceRefToResult: { ref: CellReference; result: CellImpl<any> }[] = [];

  const mapValuesToOp: Action = (log: ReactivityLog) => {
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

    let previousResult: any[] = result.getAsProxy([]) as any[];
    if (!Array.isArray(previousResult)) {
      result.setAtPath([], [], log);
      previousResult = [];
    }

    const seen: any[] = [];

    // Hack to get to underlying array that lists cell references, etc.
    const listRef = getCellReferenceOrThrow(list);
    list = listRef.cell.getAtPath(listRef.path);
    if (isCellProxy(previousResult)) {
      const previousResultRef = getCellReferenceOrThrow(previousResult);
      previousResult = previousResultRef.cell.getAtPath(previousResultRef.path);
    }

    // Update values that are new or have changed
    for (let index = 0; index < list.length; index++) {
      let value = list[index];

      // We have to manually add read logs, as we don't go via the proxy here.
      log?.reads.push({ cell: listRef.cell, path: [...listRef.path, index] });

      if (!isCellReference(value))
        throw new Error("map requires all values to be cell references");

      // TODO: Replace with something that follows aliases as well.
      value = followCellReferences(value, log);

      if (isEqualCellReferences(previousResult[index], value)) return;

      if (typeof value !== "object")
        throw new Error("map currently only supports objects");

      let itemResult = sourceRefToResult.find(({ ref }) =>
        isEqualCellReferences(ref, value)
      );
      // If the value is new, instantiate the recipe and store the result cell
      if (!itemResult) {
        const resultCell = run(op, value);
        itemResult = { ref: value, result: resultCell };
        sourceRefToResult.push(itemResult);
      }

      // Send the result value to the result cell
      result.setAtPath([index], itemResult.result, log);
      seen.push(value);
    }

    // Remove values that are no longer in the input
    sourceRefToResult = sourceRefToResult.filter(({ ref }) =>
      seen.find((seenValue) => isEqualCellReferences(seenValue, ref))
    );

    sendValueToBinding(recipeCell, outputBindings, result, log);
  };

  schedule(mapValuesToOp, {
    reads: findAllAliasedCells(inputBindings, recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}

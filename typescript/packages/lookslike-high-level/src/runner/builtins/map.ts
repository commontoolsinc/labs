import { type Recipe, type Node } from "../../builder/index.js";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { run } from "../runner.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
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
 * @param values - A cell containing an array of values to map over.
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
  const result = cell<any[]>([]);
  const valueToResult: Map<any, CellImpl<any>> = new Map();

  const mapValuesToOp: Action = (log: ReactivityLog) => {
    const { list, op } = inputsCell.getAsProxy([], log);

    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be undefined.
    if (list === undefined) {
      result.setAtPath([], undefined, log);
      return;
    }

    if (!Array.isArray(list))
      throw new Error("map currently only supports arrays");

    const previousResult = result.getAsProxy([], log);
    const seen = new Set<any>();

    // Update values that are new or have changed
    list.map((value: any, index: number) => {
      if (previousResult[index] === value) return;

      if (typeof value !== "object")
        throw new Error("map currently only supports objects");

      // If the value is new, instantiate the recipe and store the result cell
      if (!valueToResult.has(value)) {
        const resultValue = run(op, value);
        valueToResult.set(value, resultValue);
      }

      // Send the result value to the result cell
      result.setAtPath([index], valueToResult.get(value), log);
      seen.add(value);
    });

    // Remove values that are no longer in the input
    for (const value of valueToResult.keys()) {
      if (!seen.has(value)) {
        valueToResult.delete(value);
      }
    }

    sendValueToBinding(recipeCell, outputBindings, result, log);
  };

  schedule(mapValuesToOp, {
    reads: findAllAliasedCells(inputBindings, recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}

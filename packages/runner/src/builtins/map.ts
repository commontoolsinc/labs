import { type JSONSchema, type Recipe } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * Implemention of built-in map module. Unlike regular modules, this will be
 * called once at setup and thus sets up its own actions for the scheduler.
 *
 * The goal is to keep the output array current without recomputing too much.
 *
 * Approach:
 * 1. Create a doc to store the result.
 * 2. Create a handler to update the result doc when the input doc changes.
 * 3. Create a handler to update the result doc when the op doc changes.
 * 4. For each value in the input doc, create a handler to update the result
 *    doc when the value changes.
 *
 * TODO: Optimization depends on javascript objects and not lookslike objects.
 * We should make sure updates to arrays don't unnecessarily re-ify objects
 * and/or change the comparision here.
 *
 * @param list - A doc containing an array of values to map over.
 * @param op - A recipe to apply to each value.
 * @returns A doc containing the mapped values.
 */
export function map(
  inputsCell: Cell<{
    list: any[];
    op: Recipe;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  // Tracks up to where in the source array we've handled entries. Right now we
  // start at zero, even though in principle the result doc above could have
  // been pre-initalized from storage, so that we `run` each recipe. Once that
  // is automated on rehyrdation, we can change this to measure the difference
  // between the source list and the result list.
  let initializedUpTo = 0;
  let result: Cell<any[]> | undefined;

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
          list: { type: "array", items: { asCell: true } },
          op: { asCell: true },
        },
        required: ["list", "op"],
        additionalProperties: false,
      } as const satisfies JSONSchema,
    ).withTx(tx).get();

    // .getRaw() because we want the recipe itself and avoid following the
    // aliases in the recipe
    const opRecipe = op.getRaw();

    // If the result's value is undefined, set it to the empty array.
    if (resultWithLog.get() === undefined) {
      resultWithLog.set([]);
    }
    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      resultWithLog.set([]);
      // Reset progress so that once the list becomes defined again we
      // recompute from the beginning.
      initializedUpTo = 0;
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("map currently only supports arrays");
    }

    // Add values that have been appended
    while (initializedUpTo < list.length) {
      const resultCell = runtime.getCell(
        parentCell.space,
        { result, index: initializedUpTo },
        undefined,
        tx,
      );
      runtime.runner.run(
        tx,
        opRecipe,
        {
          element: inputsCell.key("list").key(initializedUpTo),
          index: initializedUpTo,
          array: inputsCell.key("list"),
        },
        resultCell,
      );
      resultCell.getSourceCell()!.setSourceCell(parentCell);
      // Add cancel from runtime's runner
      addCancel(() => runtime.runner.stop(resultCell));

      // Send the result value to the result cell
      resultWithLog.key(initializedUpTo).set(resultCell);

      initializedUpTo++;
    }

    // Shorten the result if the list got shorter
    if (resultWithLog.get().length > list.length) {
      resultWithLog.key("length").set(list.length);
      initializedUpTo = list.length;
    }

    // NOTE: We leave prior results in the list for now, so they reuse prior
    // runs when items reappear
    //
    // Remove values that are no longer in the input sourceRefToResult =
    // sourceRefToResult.filter(({ ref }) => seen.find((seenValue) =>
    // isEqualCellReferences(seenValue, ref))
    //);
  };
}

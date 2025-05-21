import { type Recipe } from "@commontools/builder";
import { type DocImpl, getDoc } from "../doc.ts";
import { getCellLinkOrThrow } from "../query-result-proxy.ts";
import { type ReactivityLog } from "../scheduler.ts";
import { cancels, run } from "../runner.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";

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
  inputsCell: DocImpl<{
    list: any[];
    op: Recipe;
  }>,
  sendResult: (result: any) => void,
  addCancel: AddCancel,
  cause: any,
  parentDoc: DocImpl<any>,
): Action {
  const result = getDoc<any[]>(
    [],
    {
      map: parentDoc.entityId,
      op: inputsCell.getAsQueryResult([])?.op,
      cause,
    },
    parentDoc.space,
  );
  result.sourceCell = parentDoc;

  sendResult({ cell: result, path: [] });

  // Tracks up to where in the source array we've handled entries. Right now we
  // start at zero, even though in principle the result doc above could have
  // been pre-initalized from storage, so that we `run` each recipe. Once that
  // is automated on rehyrdation, we can change this to measure the difference
  // between the source list and the result list.
  let initializedUpTo = 0;

  return (log: ReactivityLog) => {
    let { list, op } = inputsCell.getAsQueryResult([], log);

    // If the result's value is undefined, set it to the empty array.
    if (result.get() === undefined) {
      result.setAtPath([], [], log);
    }
    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      result.setAtPath([], [], log);
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("map currently only supports arrays");
    }

    // Hack to get to underlying array that lists doc links, etc.
    const listRef = getCellLinkOrThrow(list);

    // Same for op, but here it's so that the proxy doesn't follow the aliases
    // in the recipe instead of returning the recipe.
    // TODO(seefeld): Instead we should reify the recipe as a NodeFactory and
    // teach the query result proxy to not enter those.
    const opRef = getCellLinkOrThrow(op);
    op = opRef.cell.getAtPath(opRef.path);

    // Add values that have been appended
    while (initializedUpTo < list.length) {
      const resultCell = getDoc(
        undefined,
        { result, index: initializedUpTo },
        parentDoc.space,
      );
      run(
        op,
        {
          element: {
            cell: listRef.cell,
            path: [...listRef.path, initializedUpTo],
          },
          index: initializedUpTo,
          array: list,
        },
        resultCell,
      );
      resultCell.sourceCell!.sourceCell = parentDoc;

      // TODO(seefeld): Have `run` return cancel, once we make resultCell required
      addCancel(cancels.get(resultCell));

      // Send the result value to the result doc
      result.setAtPath([initializedUpTo], { cell: resultCell, path: [] }, log);

      initializedUpTo++;
    }

    // Shorten the result if the list got shorter
    if (result.get().length > list.length) {
      result.setAtPath(["length"], list.length, log);
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

import { type Node } from "@commontools/common-builder";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { mapBindingsToCell } from "../utils.js";

/**
 * Fetch data from a URL.
 *
 * Returns the fetched result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A cell containing the URL to fetch data from.
 * @param schema - A cell containing the JSON schema to validate the fetched data.
 * @returns { pending: boolean, result: any, error: any } - As individual cells, representing `pending` state, final `result`, and any `error`.
 */
export function fetchData(
  recipeCell: CellImpl<any>,
  { inputs, outputs }: Node
) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    url: string;
    result?: any;
  };
  const inputsCell = cell(inputBindings);

  const pending = cell(false);
  const fullResult = cell<any | undefined>(undefined);
  const error = cell<any | undefined>(undefined);

  const resultCell = cell({
    pending,
    result: fullResult,
    error,
  });

  const outputBindings = mapBindingsToCell(outputs, recipeCell) as any[];
  sendValueToBinding(recipeCell, outputBindings, resultCell);

  let currentRun = 0;

  const startFetch: Action = (log: ReactivityLog) => {
    const { url } = inputsCell.getAsProxy([], log);

    if (url === undefined) {
      pending.setAtPath([], false, log);
      fullResult.setAtPath([], undefined, log);
      error.setAtPath([], undefined, log);
      ++currentRun;
      return;
    }

    pending.setAtPath([], true, log);
    fullResult.setAtPath([], undefined, log);
    error.setAtPath([], undefined, log);

    const thisRun = ++currentRun;

    fetch(url)
      .then((response) => response.json())
      .then((data) => {
        if (thisRun !== currentRun) return;

        pending.setAtPath([], false, log);
        fullResult.setAtPath([], data, log);
      })
      .catch((err) => {
        if (thisRun !== currentRun) return;

        pending.setAtPath([], false, log);
        error.setAtPath([], err, log);
      });
  };

  schedule(startFetch, {
    reads: findAllAliasedCells(inputBindings, recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}

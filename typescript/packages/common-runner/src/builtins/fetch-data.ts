import { type Node } from "@commontools/common-builder";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { mapBindingsToCell, normalizeToCells } from "../utils.js";

/**
 * Fetch data from a URL.
 *
 * Returns the fetched result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A cell containing the URL to fetch data from.
 * @param mode - The mode to use for fetching data. Either `text` or `json`
 *   default to `json` results.
 * @returns { pending: boolean, result: any, error: any } - As individual cells, representing `pending` state, final `result`, and any `error`.
 */
export function fetchData(
  recipeCell: CellImpl<any>,
  { inputs, outputs }: Node
) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    url: string;
    mode?: "text" | "json";
    result?: any;
  };
  const inputsCell = cell(inputBindings);

  const pending = cell(false);
  const result = cell<any | undefined>(undefined);
  const error = cell<any | undefined>(undefined);

  const resultCell = cell({
    pending,
    result,
    error,
  });

  const outputBindings = mapBindingsToCell(outputs, recipeCell) as any[];
  sendValueToBinding(recipeCell, outputBindings, resultCell);

  let currentRun = 0;

  const startFetch: Action = (log: ReactivityLog) => {
    const { url, mode } = inputsCell.getAsProxy([], log);
    const processResponse =
      (mode || "json") === "json"
        ? (r: Response) => r.json()
        : (r: Response) => r.text();

    if (url === undefined) {
      pending.setAtPath([], false, log);
      result.setAtPath([], undefined, log);
      error.setAtPath([], undefined, log);
      ++currentRun;
      return;
    }

    pending.setAtPath([], true, log);
    result.setAtPath([], undefined, log);
    error.setAtPath([], undefined, log);

    const thisRun = ++currentRun;

    fetch(url)
      .then(processResponse)
      .then((data) => {
        if (thisRun !== currentRun) return;

        normalizeToCells(result, undefined, log);

        pending.setAtPath([], false, log);
        result.setAtPath([], data, log);
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

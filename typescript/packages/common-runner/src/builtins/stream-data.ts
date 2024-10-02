import { type Node } from "@commontools/common-builder";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { mapBindingsToCell } from "../utils.js";

/**
 * Stream data from a URL.
 *
 * Returns the streamed result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A cell containing the URL to stream data from.
 * @returns { pending: boolean, result: any, error: any } - As individual cells, representing `pending` state, streamed `result`, and any `error`.
 */
export function streamData(
  recipeCell: CellImpl<any>,
  { inputs, outputs }: Node
) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    url: string;
    options?: { body?: any; method?: string; headers?: Record<string, string> };
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

  const startStream: Action = async (log: ReactivityLog) => {
    const { url, options } = inputsCell.getAsProxy([], log);

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

    try {
      const response = await fetch(url, options);
      const reader = response.body?.getReader();
      const utf8 = new TextDecoder();

      if (!reader) {
        throw new Error('Response body is not readable');
      }

      while (true) {
        if (thisRun !== currentRun) return;

        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const [id, event, data] = utf8.decode(value).split('\n');
        const parsedData = {
          id: id.slice('id:'.length),
          event: event.slice('event:'.length),
          data: JSON.parse(data.slice('data:'.length))
        };

        console.log('parsed', parsedData);

        result.setAtPath([], parsedData, log);
        break;
      }

      pending.setAtPath([], false, log);
    } catch (err) {
      if (thisRun !== currentRun) return;

      pending.setAtPath([], false, log);
      error.setAtPath([], err, log);
    }
  };

  schedule(startStream, {
    reads: findAllAliasedCells(inputBindings, recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}

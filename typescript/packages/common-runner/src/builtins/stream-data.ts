import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { normalizeToCells } from "../utils.js";
import { type Action } from "../scheduler.js";

/**
 * Stream data from a URL, used for querying Synopsys.
 * Ben: This is a hack for demo purposes, we should feel free to delete this file when we have a robust integration.
 *
 * This differs from a regular fetch in that we poll in a generator loop to get all the data.
 *
 * Returns the streamed result as `result`. `pending` is true while a request is pending.
 *
 * @param url - A cell containing the URL to stream data from.
 * @returns { pending: boolean, result: any, error: any } - As individual cells, representing `pending` state, streamed `result`, and any `error`.
 */
export function streamData(
  inputsCell: CellImpl<{
    url: string;
    options?: { body?: any; method?: string; headers?: Record<string, string> };
    result?: any;
  }>,
  sendResult: (result: any) => void
): Action {
  const pending = cell(false);
  const result = cell<any | undefined>(undefined);
  const error = cell<any | undefined>(undefined);

  // Since we'll only write into the cells above, we only have to call this once
  // here, instead of in the action.
  sendResult({ pending, result, error });

  let currentRun = 0;

  return async (log: ReactivityLog) => {
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
        throw new Error("Response body is not readable");
      }

      // this reads until we hit the first response frame for now
      // after that we're ignoring future updates, obviously not where we want to be
      // but it's enough to get data on the screen
      while (true) {
        if (thisRun !== currentRun) return;

        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const [id, event, data] = utf8.decode(value).split("\n");
        const parsedData = {
          id: id.slice("id:".length),
          event: event.slice("event:".length),
          data: JSON.parse(data.slice("data:".length)),
        };

        console.log("parsed", parsedData);

        normalizeToCells(result, undefined, log);
        result.send(parsedData);
        break;
      }

      pending.setAtPath([], false, log);
    } catch (err) {
      if (thisRun !== currentRun) return;

      pending.setAtPath([], false, log);
      error.setAtPath([], err, log);
    }
  };
}

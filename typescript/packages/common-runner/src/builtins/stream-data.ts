import { cell, CellImpl, ReactivityLog } from "../cell.js";
// import { normalizeToCells } from "../utils.js";
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

  return (log: ReactivityLog) => {
    const { url, options } = inputsCell.getAsProxy([], log) || {};

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

    fetch(url, options).then(async (response) => {
      const reader = response.body?.getReader();
      const utf8 = new TextDecoder();

      if (!reader) {
        throw new Error("Response body is not readable");
      }

      let buffer = '';
      let id: string | undefined = undefined;
      let event: string | undefined = undefined;
      let data: string | undefined = undefined;

      while (true) {
        if (thisRun !== currentRun) {
          reader.cancel();
          return;
        }

        const { done, value } = await reader.read();

        buffer += utf8.decode(value);
        while (buffer.includes("\n")) {

          let line = buffer.split("\n")[0];
          buffer = buffer.slice(line.length + 1);

          if (line.startsWith("id:")) {
            id = line.slice("id:".length);
          } else if (line.startsWith("event:")) {
            event = line.slice("event:".length);
          } else if (line.startsWith("data:")) {
            data = line.slice("data:".length);
          }
        }

        if (id && event && data) {
          const parsedData = {
            id,
            event,
            data: JSON.parse(data),
          };

          // normalizeToCells(result, undefined, log);
          result.setAtPath([], parsedData, log);
          id = undefined;
          event = undefined;
          data = undefined;
        }

        if (done) {
          reader.cancel();
          break;
        }
      }
    }).catch((e) => {
      console.error(e);
      pending.setAtPath([], false, log);
      result.setAtPath([], undefined, log);
      error.setAtPath([], e, log);
    });
  };
}

import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { normalizeToCells } from "../utils.js";
import { idle, type Action } from "../scheduler.js";

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
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: CellImpl<any>[],
): Action {
  const pending = cell(false, { streamData: { pending: cause } });
  const result = cell<any | undefined>(undefined, {
    streamData: { result: cause },
  });
  const error = cell<any | undefined>(undefined, {
    streamData: { error: cause },
  });

  pending.ephemeral = true;
  result.ephemeral = true;
  error.ephemeral = true;

  // Since we'll only write into the cells above, we only have to call this once
  // here, instead of in the action.
  sendResult({ pending, result, error });

  const status = { run: 0, controller: undefined } as {
    run: number;
    controller: AbortController | undefined;
  };

  let previousCall = "";
  return (log: ReactivityLog) => {
    const { url, options } = inputsCell.getAsQueryResult([], log) || {};

    // Re-entrancy guard: Don't restart the stream if it's the same request.
    const currentCall = `${url}${JSON.stringify(options)}`;
    if (currentCall === previousCall) return;
    previousCall = currentCall;

    if (status.controller) {
      status.controller.abort();
      status.controller = undefined;
    }

    if (url === undefined) {
      pending.setAtPath([], false, log);
      result.setAtPath([], undefined, log);
      error.setAtPath([], undefined, log);
      ++status.run;
      return;
    }

    pending.setAtPath([], true, log);
    result.setAtPath([], undefined, log);
    error.setAtPath([], undefined, log);

    const controller = new AbortController();
    const signal = controller.signal;
    status.controller = controller;
    const thisRun = ++status.run;

    fetch(url, { ...options, signal })
      .then(async (response) => {
        const reader = response.body?.getReader();
        const utf8 = new TextDecoder();

        if (!reader) {
          throw new Error("Response body is not readable");
        }

        let buffer = "";
        let id: string | undefined = undefined;
        let event: string | undefined = undefined;
        let data: string | undefined = undefined;

        while (true) {
          if (thisRun !== status.run) {
            controller.abort();
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

            normalizeToCells(parsedData, undefined, log, {
              streamData: { url },
              cause,
            });

            await idle();

            result.setAtPath([], parsedData, log);
            id = undefined;
            event = undefined;
            data = undefined;
          }

          if (done) {
            break;
          }
        }
      })
      .catch(async (e) => {
        if (e instanceof DOMException && e.name === "AbortError") {
          return;
        }
        // FIXME(ja): I don't think this is the right logic... if the stream
        // disconnects, we should probably not erase the result.
        // FIXME(ja): also pending should probably be more like "live"?
        console.error(e);

        await idle();
        pending.setAtPath([], false, log);
        result.setAtPath([], undefined, log);
        error.setAtPath([], e, log);

        // Allow retrying the same request.
        previousCall = "";
      });
  };
}

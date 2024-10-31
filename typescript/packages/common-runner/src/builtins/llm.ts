import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { makeClient, SimpleMessage, SimpleContent } from "../llm-client.js";
import { type Action } from "../scheduler.js";
import { refer } from "merkle-reference";

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - A cell to store the prompt message - if you only have a single message
 * @param messages - list of messages to send to the LLM. - alternating user and assistant messages.
 *  - if you end with an assistant message, the LLM will continue from there.
 *  - if both prompt and messages are empty, no LLM call will be made,
 *    result and partial will be undefined.
 * @param system - A cell to store the system message.
 * @param stop - A cell to store (optional) stop sequence.
 * @param max_tokens - A cell to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, result?: string, partial?: string } - As individual
 *   cells, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llm(
  inputsCell: CellImpl<{
    messages?: SimpleContent[] | SimpleMessage[];
    prompt?: SimpleContent;
    stop?: string;
    system?: string;
    max_tokens?: number;
  }>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause?: any,
): Action {
  const pending = cell(false, { llm: { pending: cause } });
  const result = cell<string | undefined>(undefined, {
    llm: { result: cause },
  });
  const partial = cell<string | undefined>(undefined, {
    llm: { partial: cause },
  });
  const requestHash = cell<string | undefined>(undefined, {
    llm: { requestHash: cause },
  });

  sendResult({ pending, result, partial, requestHash });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;

    const { system, messages, prompt, stop, max_tokens } =
      inputsCell.getAsQueryResult([], log) ?? {};

    const hash = refer({
      system: system ?? "",
      messages: messages ?? [],
      prompt: prompt ?? "",
      stop: stop ?? "",
      max_tokens: max_tokens ?? 4096,
    }).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash cell).
    if (hash === previousCallHash || hash === requestHash.get()) return;
    previousCallHash = hash;

    result.setAtPath([], undefined, log);
    partial.setAtPath([], undefined, log);

    if (
      ((prompt === undefined || prompt.length === 0) &&
        (messages === undefined || messages.length === 0)) ||
      system === undefined
    ) {
      pending.setAtPath([], false, log);
      return;
    }
    pending.setAtPath([], true, log);

    const updatePartial = (text: string) => {
      if (thisRun != currentRun) return;
      partial.setAtPath([], text, log);
    };

    let resultPromise = makeClient().sendRequest(
      {
        messages: messages || [prompt as SimpleContent],
        system,
        model: "claude-3-5-sonnet-latest",
        max_tokens: max_tokens || 4096,
        stop,
      },
      updatePartial,
    );

    resultPromise
      .then((text) => {
        if (thisRun !== currentRun) return;
        // normalizeToCells(result, undefined, log);

        pending.setAtPath([], false, log);
        result.setAtPath([], text, log);
        partial.setAtPath([], text, log);
        requestHash.setAtPath([], hash, log);
      })
      .catch((error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating data", error);
        pending.setAtPath([], false, log);
        result.setAtPath([], undefined, log);
        partial.setAtPath([], undefined, log);

        // TODO: Not writing now, so we retry the request after failure. Replace
        // this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}

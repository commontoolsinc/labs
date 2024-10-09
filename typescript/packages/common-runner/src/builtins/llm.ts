import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { makeClient, SimpleMessage, SimpleContent } from "../llm-client.js";
import { type Action } from "../scheduler.js";

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
  sendResult: (result: any) => void
): Action {
  const pending = cell(false);
  const result = cell<string | undefined>(undefined);
  const partial = cell<string | undefined>(undefined);

  sendResult({ pending, result, partial });

  let currentRun = 0;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;

    const { system, messages, prompt, stop, max_tokens } =
      inputsCell.getAsProxy([], log) ?? {};

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
        model: "claude-3-5-sonnet-20240620",
        max_tokens: max_tokens || 4096,
        stop,
      },
      updatePartial
    );

    resultPromise
      .then((text) => {
        if (thisRun !== currentRun) return;
        // normalizeToCells(result, undefined, log);

        pending.setAtPath([], false, log);
        result.setAtPath([], text, log);
        partial.setAtPath([], text, log);
      })
      .catch((error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating data", error);
        pending.setAtPath([], false, log);
        result.setAtPath([], undefined, log);
        partial.setAtPath([], undefined, log);
      });
  };
}

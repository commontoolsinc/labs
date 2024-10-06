import { type Node } from "@commontools/common-builder";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { mapBindingsToCell } from "../utils.js";
import { makeClient, SimpleMessage, SimpleContent } from "../llm-client.js";

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
 * @returns { pending: boolean, result: any, partial: any } - As individual
 *   cells, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function generateText(
  recipeCell: CellImpl<any>,
  { inputs, outputs }: Node
) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    messages?: SimpleContent[] | SimpleMessage[];
    prompt?: SimpleContent;
    stop?: string;
    system?: string;
    max_tokens?: number;
  };
  const inputsCell = cell(inputBindings);

  const pending = cell(false);
  const fullResult = cell<string | undefined>(undefined);
  const partialResult = cell<string | undefined>(undefined);

  const resultCell = cell({
    pending,
    result: fullResult,
    partial: partialResult,
  });

  const outputBindings = mapBindingsToCell(outputs, recipeCell) as any[];
  sendValueToBinding(recipeCell, outputBindings, resultCell);

  let currentRun = 0;

  const startGeneration: Action = (log: ReactivityLog) => {
    const thisRun = ++currentRun;

    const { system, messages, prompt, stop, max_tokens } = inputsCell.getAsProxy([], log);

    fullResult.setAtPath([], undefined, log);
    partialResult.setAtPath([], undefined, log);

    if (((prompt === undefined || prompt.length === 0) && (messages === undefined || messages.length === 0)) || system === undefined) {
      pending.setAtPath([], false, log);
      return;
    }
    pending.setAtPath([], true, log);

    const updatePartial = (t: string) => {
      if (thisRun != currentRun) return;
      partialResult.setAtPath([], t, log);
    }

    let resultPromise = makeClient().sendRequest({
      messages: messages || [prompt as SimpleContent],
      system,
      model: "claude-3-5-sonnet-20240620",
      max_tokens: max_tokens || 4096,
      stop
    }, updatePartial)

    resultPromise
      .then((result) => {
        if (thisRun !== currentRun) return;
        // normalizeToCells(result, undefined, log);

        pending.setAtPath([], false, log);
        fullResult.setAtPath([], result, log);
        partialResult.setAtPath([], result, log);
      }).catch((error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating data", error);
        pending.setAtPath([], false, log);
        fullResult.setAtPath([], undefined, log);
        partialResult.setAtPath([], undefined, log);
      });
  };

  schedule(startGeneration, {
    reads: findAllAliasedCells(inputBindings, recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}

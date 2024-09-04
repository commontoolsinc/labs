import { type Node } from "../../builder/index.js";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { generateData as generateDataClient } from "@commontools/llm-client";
import { mapBindingsToCell } from "../utils.js";
import { mockResultClient, makeClient } from "../../llm-client.js";

// TODO: generateData should really be a recipe, not a builtin, and either the
// underlying llm client call or even just fetch the built-in.

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - A cell containing the prompt to generate data from.
 * @param result - A cell to store the generated data.
 * @param schema - A cell to store the schema of the generated data.
 * @param system - A cell overriding the default system prompt. Only `prompt`
 *   above will be used, as-is, and `result` and `schema` will be ignored.
 * @returns { pending: boolean, result: any, partial: any } - As individual
 *   cells, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function generateData(
  recipeCell: CellImpl<any>,
  { inputs, outputs }: Node
) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    prompt: string;
    result?: any;
    schema?: any;
    system?: string;
  };
  const inputsCell = cell(inputBindings);

  const pending = cell(false);
  const fullResult = cell<any | undefined>(undefined);
  const partialResult = cell<any | undefined>(undefined);

  const resultCell = cell({
    pending,
    result: fullResult,
    partial: partialResult,
  });

  const outputBindings = mapBindingsToCell(outputs, recipeCell) as any[];
  sendValueToBinding(recipeCell, outputBindings, resultCell);

  let currentRun = 0;

  const startGeneration: Action = (log: ReactivityLog) => {
    const { prompt, result, schema, system } = inputsCell.getAsProxy([], log);

    if (prompt === undefined) {
      pending.setAtPath([], false, log);
      fullResult.setAtPath([], undefined, log);
      partialResult.setAtPath([], undefined, log);
      ++currentRun;
      return;
    }

    pending.setAtPath([], true, log);
    fullResult.setAtPath([], undefined, log);
    partialResult.setAtPath([], undefined, log);

    let resultPromise: Promise<any>;
    if (system) {
      const client = makeClient(system);

      resultPromise = client
        .createThread(prompt)
        .then((thread) =>
          grabJson(thread.conversation[thread.conversation.length - 1])
        );
    } else {
      resultPromise = generateDataClient(
        mockResultClient,
        prompt,
        result,
        schema
      );
    }

    const thisRun = ++currentRun;

    resultPromise.then((result) => {
      if (thisRun !== currentRun) return;

      pending.setAtPath([], false, log);
      fullResult.setAtPath([], result, log);
      partialResult.setAtPath([], result, log);
    });
  };

  schedule(startGeneration, {
    reads: findAllAliasedCells(inputBindings, recipeCell),
    writes: findAllAliasedCells(outputBindings, recipeCell),
  });
}

function grabJson(txt: string) {
  return JSON.parse(txt.match(/```json\n([\s\S]+?)```/)?.[1] ?? "{}");
}

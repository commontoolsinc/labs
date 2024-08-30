import { type Node } from "../../builder/index.js";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { generateData as generateDataClient } from "@commontools/llm-client";
import { mapBindingsToCell } from "../utils.js";
import { mockResultClient } from "../../llm-client.js";

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - A cell containing the prompt to generate data from.
 * @param result - A cell to store the generated data.
 * @param schema - A cell to store the schema of the generated data.
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
    const { prompt, result, schema } = inputsCell.getAsProxy([], log);

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

    const resultPromise = generateDataClient(
      mockResultClient,
      prompt,
      result,
      schema
    );

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

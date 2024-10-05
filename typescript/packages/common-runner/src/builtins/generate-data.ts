import { type Node } from "@commontools/common-builder";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { SimpleMessage } from "@commontools/llm-client";
import { mapBindingsToCell, normalizeToCells } from "../utils.js";
import { makeClient, dataRequest } from "../llm-client.js";

// TODO: generateData should really be a recipe, not a builtin, and either the
// underlying llm client call or even just fetch the built-in.

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param messages - list of strings to send to the LLM. - alternating user and assistant messages.
 *  - if you end with an assistant message, the LLM will continue from there.
 *  - if empty, no LLM call will be made, result and partial will be undefined.
 * @param result - A cell to store the generated data.
 * @param schema - A cell to store the schema of the generated data.
 * @param system - A cell overriding the default system prompt. Only `prompt`
 *   above will be used, as-is, and `result` and `schema` will be ignored.
 * @param mode - The mode to use for generating data. Either `json` or `html`
 *   default to `json` results.
 *  
 * @returns { pending: boolean, result: any, partial: any } - As individual
 *   cells, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function generateData(
  recipeCell: CellImpl<any>,
  { inputs, outputs }: Node
) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    messages?: string[];
    result?: any;
    schema?: any;
    system?: string;
    mode?: "json" | "html";
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
    const { result, schema, system, mode, messages } = inputsCell.getAsProxy([], log);
    const grab = (mode || 'json') === 'json' ? grabJson : grabHtml;

    if (messages === undefined || messages.length === 0) {
      pending.setAtPath([], false, log);
      fullResult.setAtPath([], undefined, log);
      partialResult.setAtPath([], undefined, log);
      ++currentRun;
      return;
    }

    pending.setAtPath([], true, log);
    fullResult.setAtPath([], undefined, log);
    partialResult.setAtPath([], undefined, log);

    let fullMessages: SimpleMessage[] = (messages || []).map(
      (message, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: message })
    );

    // FIXME(ja): lack of system prompt => "create system prompt about json":
    let effectiveSystem = system || dataRequest({
      description: "hmm",
      inputData: result,
      jsonSchema: schema,
    })

    const updatePartial = (t: string) => partialResult.setAtPath([], t, log);

    let resultPromise = makeClient().sendRequest({
      messages: fullMessages,
      system: effectiveSystem,
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 4096,
      stop: '```'
    }, updatePartial)

    const thisRun = ++currentRun;

    resultPromise
      .then((a: SimpleMessage) => {
        console.log("result", a);
        return a;
      })
      .then((assistant: SimpleMessage) => grab(assistant.content))
      .then((result) => {
        if (thisRun !== currentRun) return;

        normalizeToCells(result, undefined, log);

        pending.setAtPath([], false, log);
        fullResult.setAtPath([], result, log);
        partialResult.setAtPath([], result, log);
      }).catch((error) => {
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

function grabJson(txt: string) {
  const jsonMatch = txt.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.log("No JSON found in text:", txt);
    return {};
  }
  return JSON.parse(jsonMatch[1]);
}

export function grabHtml(txt: string) {
  const html = txt.match(/```html\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No HTML found in text", txt);
    return "";
  }
  return { html };
}

import { type Node } from "@commontools/common-builder";
import { cell, CellImpl, ReactivityLog } from "../cell.js";
import { sendValueToBinding, findAllAliasedCells } from "../utils.js";
import { schedule, Action } from "../scheduler.js";
import { generateData as generateDataClient } from "@commontools/llm-client";
import { mapBindingsToCell, normalizeToCells } from "../utils.js";
import { mockResultClient } from "../llm-client.js";

// TODO: generateData should really be a recipe, not a builtin, and either the
// underlying llm client call or even just fetch the built-in.

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param result - A cell to store the generated data.
 * @param schema - A cell to store the schema of the generated data.
 * @param system - A cell overriding the default system prompt. Only `prompt`
 *   above will be used, as-is, and `result` and `schema` will be ignored.
 * @param mode - The mode to use for generating data. Either `json` or `html`
 *   default to `json` results.
 * @param messages - list of strings to send to the LLM. - alternating user and assistant messages.
 *   if you end with an assistant message, the LLM will continue from there.
 * @returns { pending: boolean, result: any, partial: any } - As individual
 *   cells, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function generateData(
  recipeCell: CellImpl<any>,
  { inputs, outputs }: Node
) {
  const inputBindings = mapBindingsToCell(inputs, recipeCell) as {
    result?: any;
    schema?: any;
    system?: string;
    mode?: "json" | "html";
    messages?: string[];
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
    if (grab === undefined) {
      pending.setAtPath([], false, log);
      fullResult.setAtPath([], undefined, log);
      partialResult.setAtPath([], undefined, log);
      return;
    }

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

    let resultPromise: Promise<any>;
    let fullMessages = messages?.map((message, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: message }))

    if (system) {
      resultPromise = fetch("/api/llm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: fullMessages,
          system,
          model: "claude-3-5-sonnet-20240620",
          max_tokens: 4096,
          stream: true
        })
      }).then(async (response) => {
        if (!response.body) {
          throw new Error("No response body");
        }

        // if json, just return the response
        if (response.headers.get("content-type") === "application/json") {
          return response.json().then((data) => {
            let messages = data['messages']
            let lastMessage = messages[messages.length - 1]
            console.log("lastMessage", lastMessage)
            return grab(lastMessage['content'])
          });
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let doneReading = false;
        let partialText = "";

        while (!doneReading) {
          const { value, done } = await reader.read();
          doneReading = done;
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            partialText += chunk.slice(0, -1); // remove the \n
            partialResult.setAtPath([], partialText, log);
          }
        }

        return grab(partialText);
      }).catch((err) => {
        console.error(err);
        pending.setAtPath([], false, log);
      });
    } else {
      resultPromise = generateDataClient(
        mockResultClient,
        messages[messages.length - 1],
        result,
        schema
      );
    }

    const thisRun = ++currentRun;

    resultPromise.then((result) => {
      if (thisRun !== currentRun) return;

      normalizeToCells(result, undefined, log);

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

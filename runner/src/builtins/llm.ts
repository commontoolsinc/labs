import { type DocImpl, getDoc } from "../doc.ts";
import {
  client,
  type SimpleContent,
  type SimpleMessage,
} from "@commontools/llm";
import { type Action, idle } from "../scheduler.ts";
import { refer } from "merkle-reference";
import { type ReactivityLog } from "../scheduler.ts";
// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - A doc to store the prompt message - if you only have a single message
 * @param messages - list of messages to send to the LLM. - alternating user and assistant messages.
 *  - if you end with an assistant message, the LLM will continue from there.
 *  - if both prompt and messages are empty, no LLM call will be made,
 *    result and partial will be undefined.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param max_tokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, result?: string, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llm(
  inputsCell: DocImpl<{
    messages?: SimpleContent[] | SimpleMessage[];
    prompt?: SimpleContent;
    stop?: string;
    system?: string;
    max_tokens?: number;
    model?: string;
  }>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentDoc: DocImpl<any>,
): Action {
  const pending = getDoc(false, { llm: { pending: cause } }, parentDoc.space);
  const result = getDoc<string | undefined>(
    undefined,
    {
      llm: { result: cause },
    },
    parentDoc.space,
  );
  const partial = getDoc<string | undefined>(
    undefined,
    {
      llm: { partial: cause },
    },
    parentDoc.space,
  );
  const requestHash = getDoc<string | undefined>(
    undefined,
    {
      llm: { requestHash: cause },
    },
    parentDoc.space,
  );

  sendResult({ pending, result, partial, requestHash });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;

    const { system, messages, prompt, stop, max_tokens, model } =
      inputsCell.getAsQueryResult([], log) ?? {};

    // Define types for our parameters
    type BaseParams = {
      model: string;
      messages: SimpleContent[] | SimpleMessage[];
      max_tokens: number;
    };

    type StandardParams = BaseParams & {
      system: string;
      prompt: string;
      stop: string;
    };

    type O1Params = BaseParams;

    let llmParams: StandardParams | O1Params = {
      system: system ?? "",
      messages: messages ?? [],
      prompt: prompt ?? "",
      stop: stop ?? "",
      max_tokens: max_tokens ?? 4096,
      model: model ?? "claude-3-5-sonnet",
    } as StandardParams;

    if (model?.startsWith("openai:o1")) {
      const combinedMessage = system && prompt
        ? (`${system}\n\n${prompt}` as SimpleContent)
        : ((system || prompt) as SimpleContent);

      llmParams = {
        messages: messages ?? (combinedMessage ? [combinedMessage] : []),
        model: model,
        max_tokens: max_tokens ?? 4096,
      };
    }

    const hash = refer(llmParams).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
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

    const resultPromise = client.sendRequest(llmParams, updatePartial);

    resultPromise
      .then(async (text) => {
        if (thisRun !== currentRun) return;

        //normalizeToCells(text, undefined, log);
        await idle();

        pending.setAtPath([], false, log);
        result.setAtPath([], text, log);
        partial.setAtPath([], text, log);
        requestHash.setAtPath([], hash, log);
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating data", error);

        await idle();

        pending.setAtPath([], false, log);
        result.setAtPath([], undefined, log);
        partial.setAtPath([], undefined, log);

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}

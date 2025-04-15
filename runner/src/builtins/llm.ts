import { type DocImpl, getDoc } from "../doc.ts";
import {
  client,
  type LLMRequest,
  type SimpleContent,
  type SimpleMessage,
} from "@commontools/llm";
import { type Action, idle } from "../scheduler.ts";
import { refer } from "merkle-reference";
import { type ReactivityLog } from "../scheduler.ts";
import { isObj } from "@commontools/utils";

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - The prompt message to send to the LLM - if you only have a single message
 * @param messages - List of messages to send to the LLM - alternating user and assistant messages.
 *  - if you end with an assistant message, the LLM will continue from there.
 *  - if both prompt and messages are empty, no LLM call will be made,
 *    result and partial will be undefined.
 * @param model - The LLM model to use
 * @param system - The system message to set context for the LLM
 * @param stop - Optional sequence that will stop generation when encountered
 * @param max_tokens - Maximum number of tokens to generate
 * @param mode - Optional, can be "json"
 * @param context - Optional, can be used to pass in context for logging only
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
    mode?: "json";
    context?: Record<string, string>;
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

  // HACK(seefeld): This is break abstractions to find what in the UI is the
  // charm. This layer of the code should be unaware of this, but this is only
  // for logging purposes.
  let topSource = parentDoc;
  while (topSource.sourceCell) topSource = topSource.sourceCell;
  const charm = topSource.get().resultRef?.cell as DocImpl<any> | undefined;
  const charmId = charm
    ? `${charm.space}/${JSON.parse(JSON.stringify(charm?.entityId))?.["/"]}`
    : undefined;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;

    const { system, messages, prompt, stop, max_tokens, model, mode, context } =
      inputsCell.getAsQueryResult([], log) ?? {};

    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: messages ?? [prompt],
      stop: stop ?? "",
      max_tokens: max_tokens ?? 4096,
      model: model ?? "google:gemini-2.0-flash",
      mode,
    };

    // FIXME(ja): look at if model supports system messages instead...
    // or perhaps we do this in the toolshed handler instead?
    if (model?.startsWith("openai:o1")) {
      const combinedMessage = system && prompt
        ? (`${system}\n\n${prompt}` as SimpleContent)
        : ((system || prompt) as SimpleContent);

      llmParams.messages = messages ??
        (combinedMessage ? [combinedMessage] : []);
    }

    const hash = refer(JSON.stringify(llmParams)).toString();

    // Add after hashing, since this will change a lot, but doesn't affect the request.
    llmParams.metadata = { ...(isObj(context) ? context : {}), charmId };

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

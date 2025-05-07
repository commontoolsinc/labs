import { type DocImpl, getDoc } from "../doc.ts";
import { DEFAULT_MODEL_NAME, LLMClient, LLMRequest } from "../../../llm/src/index.ts"
import { type Action, idle } from "../scheduler.ts";
import { refer } from "merkle-reference";
import { type ReactivityLog } from "../scheduler.ts";
import { BuiltInLLMParams, BuiltInLLMState } from "../../../builder/src/index.ts";

const client = new LLMClient();

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

/**
 * Generate data via an LLM.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param messages - list of messages to send to the LLM. - alternating user and assistant messages.
 *  - if you end with an assistant message, the LLM will continue from there.
 *  - if both prompt and messages are empty, no LLM call will be made,
 *    result and partial will be undefined.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param maxTokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, result?: string, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llm(
  inputsCell: DocImpl<BuiltInLLMParams>,
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

    const { system, messages, stop, maxTokens, model } =
      inputsCell.getAsQueryResult([], log) ?? {};

    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: (messages ?? []).map((content: string, index: number) => ({
        role: index % 2 ? "assistant" : "user",
        content,
      })),
      stop: stop ?? "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        // FIXME(ja): how do we get the context of space/charm id here
        // bf: I also do not know... this one is tricky
        context: "charm",
      },
      cache: true,
    };

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
      .then(async (llmResult) => {
        const text = llmResult.content;
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

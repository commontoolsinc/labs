import { type DocImpl } from "../doc.ts";
import { 
  DEFAULT_MODEL_NAME, 
  DEFAULT_GENERATE_OBJECT_MODELS,
  LLMClient, 
  LLMRequest,
  LLMGenerateObjectRequest,
} from "@commontools/llm";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import { refer } from "merkle-reference";
import { type ReactivityLog } from "../scheduler.ts";
import {
  BuiltInLLMParams,
  BuiltInLLMState,
  BuiltInGenerateObjectParams,
} from "@commontools/api";

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
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  const pending = runtime.documentMap.getDoc(
    false,
    { llm: { pending: cause } },
    parentDoc.space,
  );
  const result = runtime.documentMap.getDoc<string | undefined>(
    undefined,
    {
      llm: { result: cause },
    },
    parentDoc.space,
  );
  const partial = runtime.documentMap.getDoc<string | undefined>(
    undefined,
    {
      llm: { partial: cause },
    },
    parentDoc.space,
  );
  const requestHash = runtime.documentMap.getDoc<string | undefined>(
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

    if (!Array.isArray(messages) || messages.length === 0) {
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
        await runtime.idle();

        pending.setAtPath([], false, log);
        result.setAtPath([], text, log);
        partial.setAtPath([], text, log);
        requestHash.setAtPath([], hash, log);
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating data", error);

        await runtime.idle();

        pending.setAtPath([], false, log);
        result.setAtPath([], undefined, log);
        partial.setAtPath([], undefined, log);

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}

/**
 * Generate structured data via an LLM using JSON mode.
 *
 * Returns the complete result as `result` and the incremental result as
 * `partial`. `pending` is true while a request is pending.
 *
 * @param prompt - The prompt to send to the LLM.
 * @param schema - JSON Schema to validate the response against.
 * @param system - Optional system message.
 * @param maxTokens - Maximum number of tokens to generate.
 * @param model - Model to use (defaults to DEFAULT_GENERATE_OBJECT_MODELS).
 * @param cache - Whether to cache the response (defaults to true).
 * @param metadata - Additional metadata to pass to the LLM.
 *
 * @returns { pending: boolean, result?: object, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function generateObject(
  inputsCell: DocImpl<BuiltInGenerateObjectParams>,
  sendResult: (result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentDoc: DocImpl<any>,
  runtime: IRuntime,
): Action {
  const pending = runtime.documentMap.getDoc(
    false,
    { generateObject: { pending: cause } },
    parentDoc.space,
  );
  const result = runtime.documentMap.getDoc<Record<string, unknown> | undefined>(
    undefined,
    {
      generateObject: { result: cause },
    },
    parentDoc.space,
  );
  const partial = runtime.documentMap.getDoc<string | undefined>(
    undefined,
    {
      generateObject: { partial: cause },
    },
    parentDoc.space,
  );
  const requestHash = runtime.documentMap.getDoc<string | undefined>(
    undefined,
    {
      generateObject: { requestHash: cause },
    },
    parentDoc.space,
  );

  sendResult({ pending, result, partial, requestHash });

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;

  return (log: ReactivityLog) => {
    const thisRun = ++currentRun;

    const { prompt, maxTokens, model, schema, system, cache, metadata } =
      inputsCell.getAsQueryResult([], log) ?? {};

    if (!prompt || !schema) {
      pending.setAtPath([], false, log);
      return;
    }

    const readyMetadata = metadata ? JSON.parse(JSON.stringify(metadata)) : {};

    const generateObjectParams: LLMGenerateObjectRequest = {
      prompt,
      maxTokens: maxTokens ?? 8192,
      schema: JSON.parse(JSON.stringify(schema)),
      model: model ?? DEFAULT_GENERATE_OBJECT_MODELS,
      metadata: {
        ...readyMetadata,
        context: "charm",
      },
      cache: cache ?? true,
    };

    if (system) {
      generateObjectParams.system = system;
    }

    const hash = refer(generateObjectParams).toString();

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash || hash === requestHash.get()) return;
    previousCallHash = hash;

    result.setAtPath([], undefined, log);
    partial.setAtPath([], undefined, log);
    pending.setAtPath([], true, log);

    const resultPromise = client.generateObject(generateObjectParams);

    resultPromise
      .then(async (response) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        pending.setAtPath([], false, log);
        result.setAtPath([], response.object, log);
        requestHash.setAtPath([], hash, log);
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating object", error);

        await runtime.idle();

        pending.setAtPath([], false, log);
        result.setAtPath([], undefined, log);
        partial.setAtPath([], undefined, log);

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}

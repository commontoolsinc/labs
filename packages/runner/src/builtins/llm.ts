import {
  DEFAULT_GENERATE_OBJECT_MODELS,
  DEFAULT_MODEL_NAME,
  extractTextFromLLMResponse,
  LLMClient,
  LLMGenerateObjectRequest,
  LLMRequest,
  LLMResponse,
} from "@commontools/llm";
import {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInLLMMessage,
  BuiltInLLMParams,
} from "@commontools/api";
import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

const client = new LLMClient();

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

/**
 * Helper function to initialize cells for LLM built-ins.
 * Reduces code duplication across llm, generateText, and generateObject.
 */
function initializeCells<T>(
  runtime: IRuntime,
  parentCell: Cell<any>,
  cause: any,
  tx: IExtendedStorageTransaction,
  builtinName: "llm" | "generateText" | "generateObject",
): {
  pending: Cell<boolean>;
  result: Cell<T | undefined>;
  partial: Cell<string | undefined>;
  requestHash: Cell<string | undefined>;
} {
  const pending = runtime.getCell<boolean>(
    parentCell.space,
    { [builtinName]: { pending: cause } },
    undefined,
    tx,
  );
  pending.send(false);

  const result = runtime.getCell<T | undefined>(
    parentCell.space,
    { [builtinName]: { result: cause } },
    undefined,
    tx,
  );

  const partial = runtime.getCell<string | undefined>(
    parentCell.space,
    { [builtinName]: { partial: cause } },
    undefined,
    tx,
  );

  const requestHash = runtime.getCell<string | undefined>(
    parentCell.space,
    { [builtinName]: { requestHash: cause } },
    undefined,
    tx,
  );

  return { pending, result, partial, requestHash };
}

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
 * @returns { pending: boolean, result?: Array<{type: string, text: string}>, partial?: string } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llm(
  inputsCell: Cell<BuiltInLLMParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<LLMResponse["content"] | undefined>;
  let partial: Cell<LLMResponse["content"] | undefined>;
  let requestHash: Cell<string | undefined>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      const cells = initializeCells<LLMResponse["content"]>(
        runtime,
        parentCell,
        cause,
        tx,
        "llm",
      );
      pending = cells.pending;
      result = cells.result;
      partial = cells.partial;
      requestHash = cells.requestHash;

      sendResult(tx, { pending, result, partial, requestHash });
      cellsInitialized = true;
    }
    const thisRun = ++currentRun;
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const { system, messages, stop, maxTokens, model } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: messages ?? [],
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
    if (hash === previousCallHash || hash === requestHashWithLog.get()) return;
    previousCallHash = hash;

    if (!Array.isArray(messages) || messages.length === 0) {
      resultWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    resultWithLog.set(undefined);
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    const updatePartial = (text: string) => {
      if (thisRun != currentRun) return;
      // TODO(bf): we should consider an `asyncTx` pattern here akin to `stream-data.ts`
      const status = tx.status();
      if (status.status !== "ready") return;

      partialWithLog.set(text);
    };

    const resultPromise = client.sendRequest(llmParams, updatePartial);

    resultPromise
      .then(async (llmResult) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(llmResult.content);
          partial.withTx(tx).set(extractTextFromLLMResponse(llmResult));
          requestHash.withTx(tx).set(hash);
        });
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating data", error);

        await runtime.idle();

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(undefined);
          partial.withTx(tx).set(undefined);
        });

        // Reset previousCallHash to allow retry after error
        previousCallHash = undefined;

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}

/**
 * Generate text via an LLM.
 *
 * A simplified alternative to `llm` that takes a single prompt string and
 * optional system message, returning plain text rather than a structured
 * content array.
 *
 * Returns the complete result as `result` (string) and the incremental result
 * as `partial` (string). `pending` is true while a request is pending.
 *
 * @param prompt - The user prompt/message to send to the LLM.
 * @param system - Optional system message.
 * @param model - Model to use (defaults to DEFAULT_MODEL_NAME).
 * @param maxTokens - Maximum number of tokens to generate (defaults to 4096).
 *
 * @returns { pending: boolean, result?: string, partial?: string, requestHash?: string } -
 *   As individual docs, representing `pending` state, final `result` and
 *   incrementally updating `partial` result.
 */
export function generateText(
  inputsCell: Cell<BuiltInGenerateTextParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<string | undefined>;
  let partial: Cell<string | undefined>;
  let requestHash: Cell<string | undefined>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      const cells = initializeCells<string>(
        runtime,
        parentCell,
        cause,
        tx,
        "generateText",
      );
      pending = cells.pending;
      result = cells.result;
      partial = cells.partial;
      requestHash = cells.requestHash;

      sendResult(tx, { pending, result, partial, requestHash });
      cellsInitialized = true;
    }
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const { system, prompt, model, maxTokens } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    // If no prompt is provided, don't make a request
    if (!prompt) {
      resultWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    // Convert simple prompt to messages array format for LLM client
    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: [{ role: "user", content: prompt }],
      stop: "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        context: "charm",
      },
      cache: true,
    };

    const hash = refer(llmParams).toString();
    const currentRequestHash = requestHashWithLog.get();
    const currentResult = resultWithLog.get();

    // Return if the same request is being made again
    // Only skip if we have a result - otherwise we need to (re)make the request
    if (currentResult !== undefined && hash === currentRequestHash) {
      return;
    }

    // Also skip if this is the same request in the current transaction
    if (hash === previousCallHash) {
      return;
    }

    previousCallHash = hash;

    // Only increment currentRun if this is a NEW request (different hash)
    // This prevents abandoning in-flight requests when the same params are re-evaluated
    if (hash !== currentRequestHash) {
      currentRun++;
    }
    const thisRun = currentRun;

    resultWithLog.set(undefined);
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    const updatePartial = (text: string) => {
      if (thisRun != currentRun) return;
      const status = tx.status();
      if (status.status !== "ready") return;

      partialWithLog.set(text);
    };

    const resultPromise = client.sendRequest(llmParams, updatePartial);

    resultPromise
      .then(async (llmResult) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        // Extract text from the LLM response
        const textResult = extractTextFromLLMResponse(llmResult);

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(textResult);
          partial.withTx(tx).set(textResult);
          requestHash.withTx(tx).set(hash);
        });
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating text", error);

        await runtime.idle();

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(undefined);
          partial.withTx(tx).set(undefined);
        });

        // Reset previousCallHash to allow retry after error
        previousCallHash = undefined;

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
export function generateObject<T extends Record<string, unknown>>(
  inputsCell: Cell<BuiltInGenerateObjectParams>,
  sendResult: (tx: IExtendedStorageTransaction, docs: {
    pending: Cell<boolean>;
    result: Cell<T | undefined>;
    partial: Cell<string | undefined>;
    requestHash: Cell<string | undefined>;
  }) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<T | undefined>;
  let partial: Cell<string | undefined>;
  let requestHash: Cell<string | undefined>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      const cells = initializeCells<T>(
        runtime,
        parentCell,
        cause,
        tx,
        "generateObject",
      );
      pending = cells.pending;
      result = cells.result;
      partial = cells.partial;
      requestHash = cells.requestHash;

      sendResult(tx, { pending, result, partial, requestHash });
      cellsInitialized = true;
    }
    const thisRun = ++currentRun;
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const { prompt, maxTokens, model, schema, system, cache, metadata } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    if (!prompt || !schema) {
      resultWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    const readyMetadata = metadata ? JSON.parse(JSON.stringify(metadata)) : {};

    // Convert prompt to messages format, consistent with generateText
    const messages: BuiltInLLMMessage[] = [{ role: "user", content: prompt }];

    const generateObjectParams: LLMGenerateObjectRequest = {
      messages,
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
    if (hash === previousCallHash || hash === requestHashWithLog.get()) return;
    previousCallHash = hash;

    resultWithLog.set({} as any); // FIXME(ja): setting result to undefined causes a storage conflict
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    const resultPromise = client.generateObject(
      generateObjectParams,
    ) as Promise<{
      object: T;
    }>;

    resultPromise
      .then(async (response) => {
        if (thisRun !== currentRun) return;

        await runtime.idle();

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(response.object);
          requestHash.withTx(tx).set(hash);
        });
      })
      .catch(async (error) => {
        if (thisRun !== currentRun) return;

        console.error("Error generating object", error);

        await runtime.idle();

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(undefined);
          partial.withTx(tx).set(undefined);
        });

        // Reset previousCallHash to allow retry after error
        previousCallHash = undefined;

        // TODO(seefeld): Not writing now, so we retry the request after failure.
        // Replace this with more fine-grained retry logic.
        // requestHash.setAtPath([], hash, log);
      });
  };
}

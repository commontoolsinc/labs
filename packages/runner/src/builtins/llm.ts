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
import { llmToolExecutionHelpers } from "./llm-dialog.ts";

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
 * Creates an updatePartial callback that safely updates the partial cell
 * during streaming, checking if the transaction is still valid and the
 * run hasn't been superseded.
 */
function createUpdatePartialCallback<T>(
  partialCell: Cell<T>,
  tx: IExtendedStorageTransaction,
  getCurrentRun: () => number,
  thisRun: number,
): (text: string) => void {
  return (text: string) => {
    if (thisRun !== getCurrentRun()) return;
    const status = tx.status();
    if (status.status !== "ready") return;

    partialCell.withTx(tx).set(text as T);
  };
}

/**
 * Common tool execution loop shared between llm, generateText, and generateObject.
 * Handles the recursive tool calling pattern where the LLM can call tools,
 * receive results, and continue the conversation.
 */
async function executeWithToolsLoop(params: {
  initialMessages: BuiltInLLMMessage[];
  llmParams: LLMRequest;
  toolCatalog: ReturnType<typeof llmToolExecutionHelpers.buildToolCatalog>;
  updatePartial: (text: string) => void;
  runtime: IRuntime;
  space: any;
  getCurrentRun: () => number;
  thisRun: number;
  onComplete: (llmResult: LLMResponse) => Promise<void>;
}): Promise<void> {
  const {
    llmParams,
    toolCatalog,
    updatePartial,
    runtime,
    space,
    getCurrentRun,
    thisRun,
    onComplete,
  } = params;

  const executeRecursive = async (
    currentMessages: BuiltInLLMMessage[],
  ): Promise<void> => {
    if (thisRun !== getCurrentRun()) return;

    const requestParams: LLMRequest = {
      ...llmParams,
      messages: currentMessages,
      tools: toolCatalog?.llmTools,
    };

    const llmResult = await client.sendRequest(requestParams, updatePartial);

    if (thisRun !== getCurrentRun()) return;

    const toolCallParts = llmToolExecutionHelpers.extractToolCallParts(
      llmResult.content,
    );
    const hasToolCalls = toolCallParts.length > 0;

    if (hasToolCalls && toolCatalog) {
      const assistantMessage = llmToolExecutionHelpers.buildAssistantMessage(
        llmResult.content,
        toolCallParts,
      );

      const toolResults = await llmToolExecutionHelpers.executeToolCalls(
        runtime,
        space,
        toolCatalog,
        toolCallParts,
      );

      const toolResultMessages = llmToolExecutionHelpers
        .createToolResultMessages(toolResults);

      const updatedMessages = [
        ...currentMessages,
        assistantMessage,
        ...toolResultMessages,
      ];

      await executeRecursive(updatedMessages);
    } else {
      // No more tool calls, finish
      await onComplete(llmResult);
    }
  };

  await executeRecursive(params.initialMessages);
}

/**
 * Common error handler for LLM requests.
 * Resets state and allows retry on next invocation.
 */
async function handleLLMError<T, P>(
  error: unknown,
  runtime: IRuntime,
  pending: Cell<boolean>,
  result: Cell<T>,
  partial: Cell<P>,
  getCurrentRun: () => number,
  thisRun: number,
  resetPreviousHash: () => void,
): Promise<void> {
  if (thisRun !== getCurrentRun()) return;

  console.error("Error in LLM request", error);

  await runtime.idle();

  await runtime.editWithRetry((tx) => {
    pending.withTx(tx).set(false);
    result.withTx(tx).set(undefined as T);
    partial.withTx(tx).set(undefined as P);
  });

  resetPreviousHash();
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

    const { system, messages, stop, maxTokens, model, tools } =
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
      // tools will be added below if present
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

    const updatePartial = createUpdatePartialCallback(
      partial,
      tx,
      () => currentRun,
      thisRun,
    );

    // Build tool catalog if tools are present, then start execution
    const resultPromise = (async () => {
      const toolsCell = tools ? inputsCell.key("tools") : undefined;
      const toolCatalog = toolsCell
        ? llmToolExecutionHelpers.buildToolCatalog(runtime, toolsCell)
        : undefined;

      await executeWithToolsLoop({
        initialMessages: messages ?? [],
        llmParams,
        toolCatalog: toolCatalog!,
        updatePartial,
        runtime,
        space: parentCell.space,
        getCurrentRun: () => currentRun,
        thisRun,
        onComplete: async (llmResult) => {
          await runtime.idle();

          await runtime.editWithRetry((tx) => {
            pending.withTx(tx).set(false);
            result.withTx(tx).set(llmResult.content);
            partial.withTx(tx).set(extractTextFromLLMResponse(llmResult));
            requestHash.withTx(tx).set(hash);
          });
        },
      });
    })();

    resultPromise.catch((error) =>
      handleLLMError(
        error,
        runtime,
        pending,
        result,
        partial,
        () => currentRun,
        thisRun,
        () => {
          previousCallHash = undefined;
        },
      )
    );
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

    const { system, prompt, messages, model, maxTokens, tools } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    // If neither prompt nor messages is provided, don't make a request
    if (!prompt && !messages) {
      resultWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    // Convert prompt to messages if provided, otherwise use messages directly
    const requestMessages: BuiltInLLMMessage[] = messages ||
      [{ role: "user", content: prompt! }];

    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: requestMessages,
      stop: "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        context: "charm",
      },
      cache: true,
      // tools will be added below if present
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

    const updatePartial = createUpdatePartialCallback(
      partial,
      tx,
      () => currentRun,
      thisRun,
    );

    // Build tool catalog if tools are present, then start execution
    const resultPromise = (async () => {
      const toolsCell = tools ? inputsCell.key("tools") : undefined;
      const toolCatalog = toolsCell
        ? llmToolExecutionHelpers.buildToolCatalog(runtime, toolsCell)
        : undefined;

      await executeWithToolsLoop({
        initialMessages: requestMessages,
        llmParams,
        toolCatalog: toolCatalog!,
        updatePartial,
        runtime,
        space: parentCell.space,
        getCurrentRun: () => currentRun,
        thisRun,
        onComplete: async (llmResult) => {
          await runtime.idle();

          const textResult = extractTextFromLLMResponse(llmResult);

          await runtime.editWithRetry((tx) => {
            pending.withTx(tx).set(false);
            result.withTx(tx).set(textResult);
            partial.withTx(tx).set(textResult);
            requestHash.withTx(tx).set(hash);
          });
        },
      });
    })();

    resultPromise.catch((error) =>
      handleLLMError(
        error,
        runtime,
        pending,
        result,
        partial,
        () => currentRun,
        thisRun,
        () => {
          previousCallHash = undefined;
        },
      )
    );
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
 * @param tools - Optional tools to make available to the LLM.
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
    const pendingWithLog = pending.withTx(tx);
    const resultWithLog = result.withTx(tx);
    const partialWithLog = partial.withTx(tx);
    const requestHashWithLog = requestHash.withTx(tx);

    const {
      prompt,
      messages,
      maxTokens,
      model,
      schema,
      system,
      cache,
      metadata,
      tools,
    } = inputsCell.getAsQueryResult([], tx) ?? {};

    if ((!prompt && (!messages || messages.length === 0)) || !schema) {
      resultWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    const readyMetadata = metadata ? JSON.parse(JSON.stringify(metadata)) : {};

    // Convert prompt to messages if provided, otherwise use messages directly
    const requestMessages: BuiltInLLMMessage[] = messages ||
      [{ role: "user", content: prompt! }];

    // Determine whether to use the tool-calling path or the direct generateObject path
    const hasTools = tools !== undefined;

    if (hasTools) {
      // Use tool-calling path with finalResult builtin tool
      const llmParams: LLMRequest = {
        system: system ?? "",
        messages: requestMessages,
        stop: "",
        maxTokens: maxTokens ?? 8192,
        stream: true,
        model: model ?? DEFAULT_GENERATE_OBJECT_MODELS,
        metadata: {
          ...readyMetadata,
          context: "charm",
        },
        cache: cache ?? true,
      };

      const hash = refer({ ...llmParams, schema }).toString();
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();

      // Return if the same request is being made again
      if (currentResult !== undefined && hash === currentRequestHash) {
        return;
      }

      if (hash === previousCallHash) {
        return;
      }

      previousCallHash = hash;

      if (hash !== currentRequestHash) {
        currentRun++;
      }
      const thisRun = currentRun;

      resultWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(true);

      const updatePartial = createUpdatePartialCallback(
        partial,
        tx,
        () => currentRun,
        thisRun,
      );

      // Build tool catalog with finalResult tool
      const resultPromise = (async () => {
        const toolsCell = inputsCell.key("tools");
        const baseCatalog = llmToolExecutionHelpers.buildToolCatalog(
          runtime,
          toolsCell,
        );

        // Add finalResult builtin tool
        const toolCatalog = {
          ...baseCatalog,
          llmTools: {
            ...baseCatalog.llmTools,
            [llmToolExecutionHelpers.FINAL_RESULT_TOOL_NAME]: {
              description:
                "Call this tool with the final structured result matching the required schema. This should be your last action.",
              inputSchema: JSON.parse(JSON.stringify(schema)),
            },
          },
        };

        // Execute with tools - capture finalResult when called
        let finalResult: T | undefined;

        // Custom execution loop for generateObject with finalResult extraction
        const executeRecursive = async (
          currentMessages: BuiltInLLMMessage[],
        ): Promise<void> => {
          if (thisRun !== currentRun) return;

          const requestParams: LLMRequest = {
            ...llmParams,
            messages: currentMessages,
            tools: toolCatalog.llmTools,
          };

          const llmResult = await client.sendRequest(
            requestParams,
            updatePartial,
          );

          if (thisRun !== currentRun) return;

          const toolCallParts = llmToolExecutionHelpers.extractToolCallParts(
            llmResult.content,
          );
          const hasToolCalls = toolCallParts.length > 0;

          if (hasToolCalls) {
            const assistantMessage = llmToolExecutionHelpers
              .buildAssistantMessage(
                llmResult.content,
                toolCallParts,
              );

            const toolResults = await llmToolExecutionHelpers.executeToolCalls(
              runtime,
              parentCell.space,
              toolCatalog,
              toolCallParts,
            );

            // Check if finalResult was called
            const finalResultCall = toolCallParts.find(
              (p) =>
                p.toolName === llmToolExecutionHelpers.FINAL_RESULT_TOOL_NAME,
            );
            if (finalResultCall) {
              finalResult = finalResultCall.input as T;
            }

            const toolResultMessages = llmToolExecutionHelpers
              .createToolResultMessages(toolResults);

            const updatedMessages = [
              ...currentMessages,
              assistantMessage,
              ...toolResultMessages,
            ];

            // Continue if finalResult wasn't called yet
            if (!finalResultCall) {
              await executeRecursive(updatedMessages);
            }
          } else {
            throw new Error(
              "LLM did not call finalResult tool with structured data",
            );
          }
        };

        await executeRecursive(requestMessages);

        if (finalResult === undefined) {
          throw new Error("finalResult was never called");
        }

        return finalResult;
      })();

      resultPromise
        .then(async (objectResult) => {
          if (thisRun !== currentRun) return;

          await runtime.idle();

          await runtime.editWithRetry((tx) => {
            pending.withTx(tx).set(false);
            result.withTx(tx).set(objectResult);
            requestHash.withTx(tx).set(hash);
          });
        })
        .catch((error) =>
          handleLLMError(
            error,
            runtime,
            pending,
            result,
            partial,
            () => currentRun,
            thisRun,
            () => {
              previousCallHash = undefined;
            },
          )
        );
    } else {
      // Use direct generateObject path (no tools)
      const generateObjectParams: LLMGenerateObjectRequest = {
        messages: requestMessages,
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
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();

      if (currentResult !== undefined && hash === currentRequestHash) {
        return;
      }

      if (hash === previousCallHash) {
        return;
      }

      previousCallHash = hash;

      if (hash !== currentRequestHash) {
        currentRun++;
      }
      const thisRun = currentRun;

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
        .catch((error) =>
          handleLLMError(
            error,
            runtime,
            pending,
            result,
            partial,
            () => currentRun,
            thisRun,
            () => {
              previousCallHash = undefined;
            },
          )
        );
    }
  };
}

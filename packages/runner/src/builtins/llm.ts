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
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { llmToolExecutionHelpers } from "./llm-dialog.ts";
import {
  type AsyncOperationCache,
  asyncOperationCacheSchema,
  computeInputHash,
  getState,
  isTimedOut,
  transitionToError,
  transitionToFetching,
  transitionToIdle,
  transitionToSuccess,
  updatePartial,
} from "./async-operation-state.ts";

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
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<LLMResponse["content"] | undefined>;
  let partial: Cell<string | undefined>;
  let error: Cell<string | undefined>;
  let cache: Cell<
    Record<string, AsyncOperationCache<LLMResponse["content"], string>>
  >;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell<boolean>(
        parentCell.space,
        { llm: { pending: cause } },
        undefined,
        tx,
      );

      result = runtime.getCell<LLMResponse["content"] | undefined>(
        parentCell.space,
        { llm: { result: cause } },
        undefined,
        tx,
      );

      partial = runtime.getCell<string | undefined>(
        parentCell.space,
        { llm: { partial: cause } },
        undefined,
        tx,
      );

      error = runtime.getCell<string | undefined>(
        parentCell.space,
        { llm: { error: cause } },
        undefined,
        tx,
      );

      cache = runtime.getCell(
        parentCell.space,
        { llm: { cache: cause } },
        asyncOperationCacheSchema,
        tx,
      ) as Cell<
        Record<string, AsyncOperationCache<LLMResponse["content"], string>>
      >;

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      partial.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      cache.setSourceCell(parentCell);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      partial.sync();
      error.sync();
      cache.sync();

      cellsInitialized = true;
    }

    const { system, messages, stop, maxTokens, model, tools } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    // Compute input hash for this request
    const inputHash = computeInputHash(tx, inputsCell);

    if (!Array.isArray(messages) || messages.length === 0) {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      partial.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, partial, error });
      return;
    }

    // Get current state for this input hash
    const state = getState(cache, inputHash, tx);

    // State machine transitions
    if (state.type === "idle") {
      // Try to transition to fetching
      const requestId = crypto.randomUUID();
      transitionToFetching(cache, inputHash, requestId, tx);

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

      startLLM(
        runtime,
        cache,
        inputHash,
        llmParams,
        messages,
        tools ? inputsCell.key("tools") : undefined,
        requestId,
      );
    } else if (state.type === "fetching") {
      // Check for timeout (60 seconds for LLM requests with potential tool execution)
      if (isTimedOut(state, 60000)) {
        transitionToIdle(cache, inputHash, state.requestId, tx);
      }
    }

    // Convert state machine state to output cells
    const currentState = getState(cache, inputHash, tx);
    pending.withTx(tx).set(currentState.type === "fetching");
    result.withTx(tx).set(
      currentState.type === "success" ? currentState.data : undefined,
    );
    partial.withTx(tx).set(
      currentState.type === "fetching"
        ? currentState.partial
        : (currentState.type === "success"
          ? (Array.isArray(currentState.data)
            ? currentState.data
              .filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join(" ")
            : String(currentState.data))
          : undefined),
    );
    error.withTx(tx).set(
      currentState.type === "error" ? currentState.error : undefined,
    );

    sendResult(tx, { pending, result, partial, error });
  };
}

/**
 * Start LLM request with streaming and tool execution support.
 * Uses CAS to ensure only the tab that initiated the request can write the result.
 */
async function startLLM(
  runtime: IRuntime,
  cache: Cell<
    Record<string, AsyncOperationCache<LLMResponse["content"], string>>
  >,
  inputHash: string,
  llmParams: LLMRequest,
  initialMessages: BuiltInLLMMessage[],
  toolsCell: Cell<any> | undefined,
  requestId: string,
) {
  try {
    // Build tool catalog if tools are present
    const toolCatalog = toolsCell
      ? await llmToolExecutionHelpers.buildToolCatalog(runtime, toolsCell)
      : undefined;

    // Recursive function to handle tool execution loop
    const executeWithTools = async (
      currentMessages: BuiltInLLMMessage[],
    ): Promise<LLMResponse["content"]> => {
      const requestParams: LLMRequest = {
        ...llmParams,
        messages: currentMessages,
        tools: toolCatalog?.llmTools,
      };

      // Stream updates to the partial field (as text)
      const partialCallback = (text: string) => {
        updatePartial(runtime, cache, inputHash, text, requestId);
      };

      const llmResult = await client.sendRequest(
        requestParams,
        partialCallback,
      );

      // Check if there are tool calls in the response
      const toolCallParts = llmToolExecutionHelpers.extractToolCallParts(
        llmResult.content,
      );
      const hasToolCalls = toolCallParts.length > 0;

      if (hasToolCalls && toolCatalog) {
        // Execute tools and continue conversation
        const assistantMessage = llmToolExecutionHelpers.buildAssistantMessage(
          llmResult.content,
          toolCallParts,
        );

        const toolResults = await llmToolExecutionHelpers.executeToolCalls(
          runtime,
          cache.space,
          toolCatalog,
          toolCallParts,
        );

        const toolResultMessages = llmToolExecutionHelpers
          .createToolResultMessages(toolResults);

        // Build new message history with assistant message + tool results
        const updatedMessages = [
          ...currentMessages,
          assistantMessage,
          ...toolResultMessages,
        ];

        // Continue conversation with tool results (recursive call)
        return await executeWithTools(updatedMessages);
      } else {
        // No more tool calls, return content array
        return llmResult.content;
      }
    };

    const contentResult = await executeWithTools(initialMessages);

    await runtime.idle();

    // CAS: Only write if we're still the active request
    await transitionToSuccess(
      runtime,
      cache,
      inputHash,
      contentResult,
      requestId,
    );
  } catch (err) {
    console.error("Error generating data", err);

    await runtime.idle();

    // CAS: Only write error if we're still the active request
    await transitionToError(
      runtime,
      cache,
      inputHash,
      err instanceof Error ? err.message : String(err),
      requestId,
    );
  }
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
 * @returns { pending: boolean, result?: string, partial?: string, error?: string } -
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
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<string | undefined>;
  let partial: Cell<string | undefined>;
  let error: Cell<string | undefined>;
  let cache: Cell<Record<string, AsyncOperationCache<string, string>>>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell<boolean>(
        parentCell.space,
        { generateText: { pending: cause } },
        undefined,
        tx,
      );

      result = runtime.getCell<string | undefined>(
        parentCell.space,
        { generateText: { result: cause } },
        undefined,
        tx,
      );

      partial = runtime.getCell<string | undefined>(
        parentCell.space,
        { generateText: { partial: cause } },
        undefined,
        tx,
      );

      error = runtime.getCell<string | undefined>(
        parentCell.space,
        { generateText: { error: cause } },
        undefined,
        tx,
      );

      cache = runtime.getCell(
        parentCell.space,
        { generateText: { cache: cause } },
        asyncOperationCacheSchema,
        tx,
      ) as Cell<Record<string, AsyncOperationCache<string, string>>>;

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      partial.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      cache.setSourceCell(parentCell);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      partial.sync();
      error.sync();
      cache.sync();

      cellsInitialized = true;
    }

    const { system, prompt, messages, model, maxTokens, tools } =
      inputsCell.getAsQueryResult([], tx) ?? {};

    // Compute input hash for this request
    const inputHash = computeInputHash(tx, inputsCell);

    // If neither prompt nor messages is provided, don't make a request
    if (!prompt && !messages) {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      partial.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, partial, error });
      return;
    }

    // Get current state for this input hash
    const state = getState(cache, inputHash, tx);

    // State machine transitions
    if (state.type === "idle") {
      // Try to transition to fetching
      const requestId = crypto.randomUUID();
      transitionToFetching(cache, inputHash, requestId, tx);

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

      startGenerateText(
        runtime,
        cache,
        inputHash,
        llmParams,
        requestMessages,
        tools ? inputsCell.key("tools") : undefined,
        requestId,
      );
    } else if (state.type === "fetching") {
      // Check for timeout (60 seconds for LLM requests with potential tool execution)
      if (isTimedOut(state, 60000)) {
        transitionToIdle(cache, inputHash, state.requestId, tx);
      }
    }

    // Convert state machine state to output cells
    const currentState = getState(cache, inputHash, tx);
    pending.withTx(tx).set(currentState.type === "fetching");
    result.withTx(tx).set(
      currentState.type === "success" ? currentState.data : undefined,
    );
    partial.withTx(tx).set(
      currentState.type === "fetching"
        ? currentState.partial
        : (currentState.type === "success" ? currentState.data : undefined),
    );
    error.withTx(tx).set(
      currentState.type === "error" ? currentState.error : undefined,
    );

    sendResult(tx, { pending, result, partial, error });
  };
}

/**
 * Start generating text with streaming and tool execution support.
 * Uses CAS to ensure only the tab that initiated the request can write the result.
 */
async function startGenerateText(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<string, string>>>,
  inputHash: string,
  llmParams: LLMRequest,
  initialMessages: BuiltInLLMMessage[],
  toolsCell: Cell<any> | undefined,
  requestId: string,
) {
  try {
    // Build tool catalog if tools are present
    const toolCatalog = toolsCell
      ? await llmToolExecutionHelpers.buildToolCatalog(runtime, toolsCell)
      : undefined;

    // Recursive function to handle tool execution loop
    const executeWithTools = async (
      currentMessages: BuiltInLLMMessage[],
    ): Promise<string> => {
      const requestParams: LLMRequest = {
        ...llmParams,
        messages: currentMessages,
        tools: toolCatalog?.llmTools,
      };

      // Stream updates to the partial field
      const partialCallback = (text: string) => {
        updatePartial(runtime, cache, inputHash, text, requestId);
      };

      const llmResult = await client.sendRequest(
        requestParams,
        partialCallback,
      );

      // Check if there are tool calls in the response
      const toolCallParts = llmToolExecutionHelpers.extractToolCallParts(
        llmResult.content,
      );
      const hasToolCalls = toolCallParts.length > 0;

      if (hasToolCalls && toolCatalog) {
        // Execute tools and continue conversation
        const assistantMessage = llmToolExecutionHelpers.buildAssistantMessage(
          llmResult.content,
          toolCallParts,
        );

        const toolResults = await llmToolExecutionHelpers.executeToolCalls(
          runtime,
          cache.space,
          toolCatalog,
          toolCallParts,
        );

        const toolResultMessages = llmToolExecutionHelpers
          .createToolResultMessages(toolResults);

        // Build new message history with assistant message + tool results
        const updatedMessages = [
          ...currentMessages,
          assistantMessage,
          ...toolResultMessages,
        ];

        // Continue conversation with tool results (recursive call)
        return await executeWithTools(updatedMessages);
      } else {
        // No more tool calls, extract and return final text
        return extractTextFromLLMResponse(llmResult);
      }
    };

    const textResult = await executeWithTools(initialMessages);

    await runtime.idle();

    // CAS: Only write if we're still the active request
    await transitionToSuccess(
      runtime,
      cache,
      inputHash,
      textResult,
      requestId,
    );
  } catch (err) {
    console.error("Error generating text", err);

    await runtime.idle();

    // CAS: Only write error if we're still the active request
    await transitionToError(
      runtime,
      cache,
      inputHash,
      err instanceof Error ? err.message : String(err),
      requestId,
    );
  }
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
    error: Cell<string | undefined>;
  }) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime,
): Action {
  let cellsInitialized = false;
  let pending: Cell<boolean>;
  let result: Cell<T | undefined>;
  let partial: Cell<string | undefined>;
  let error: Cell<string | undefined>;
  let cache: Cell<Record<string, AsyncOperationCache<T, string>>>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      pending = runtime.getCell<boolean>(
        parentCell.space,
        { generateObject: { pending: cause } },
        undefined,
        tx,
      );

      result = runtime.getCell<T | undefined>(
        parentCell.space,
        { generateObject: { result: cause } },
        undefined,
        tx,
      );

      partial = runtime.getCell<string | undefined>(
        parentCell.space,
        { generateObject: { partial: cause } },
        undefined,
        tx,
      );

      error = runtime.getCell<string | undefined>(
        parentCell.space,
        { generateObject: { error: cause } },
        undefined,
        tx,
      );

      cache = runtime.getCell(
        parentCell.space,
        { generateObject: { cache: cause } },
        asyncOperationCacheSchema,
        tx,
      ) as Cell<Record<string, AsyncOperationCache<T, string>>>;

      pending.setSourceCell(parentCell);
      result.setSourceCell(parentCell);
      partial.setSourceCell(parentCell);
      error.setSourceCell(parentCell);
      cache.setSourceCell(parentCell);

      // Kick off sync in the background
      pending.sync();
      result.sync();
      partial.sync();
      error.sync();
      cache.sync();

      cellsInitialized = true;
    }

    const {
      prompt,
      messages,
      maxTokens,
      model,
      schema,
      system,
      cache: cacheParam,
      metadata,
    } = inputsCell.getAsQueryResult([], tx) ?? {};

    // Compute input hash for this request
    const inputHash = computeInputHash(tx, inputsCell);

    if ((!prompt && (!messages || messages.length === 0)) || !schema) {
      // When inputs are invalid, clear outputs
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      partial.withTx(tx).set(undefined);
      error.withTx(tx).set(undefined);
      sendResult(tx, { pending, result, partial, error });
      return;
    }

    // Get current state for this input hash
    const state = getState(cache, inputHash, tx);

    // State machine transitions
    if (state.type === "idle") {
      // Try to transition to fetching
      const requestId = crypto.randomUUID();
      transitionToFetching(cache, inputHash, requestId, tx);

      const readyMetadata = metadata
        ? JSON.parse(JSON.stringify(metadata))
        : {};

      // Convert prompt to messages if provided, otherwise use messages directly
      const requestMessages: BuiltInLLMMessage[] = messages ||
        [{ role: "user", content: prompt! }];

      const generateObjectParams: LLMGenerateObjectRequest = {
        messages: requestMessages,
        maxTokens: maxTokens ?? 8192,
        schema: JSON.parse(JSON.stringify(schema)),
        model: model ?? DEFAULT_GENERATE_OBJECT_MODELS,
        metadata: {
          ...readyMetadata,
          context: "charm",
        },
        cache: cacheParam ?? true,
      };

      if (system) {
        generateObjectParams.system = system;
      }

      startGenerateObject(
        runtime,
        cache,
        inputHash,
        generateObjectParams,
        requestId,
      );
    } else if (state.type === "fetching") {
      // Check for timeout (30 seconds for LLM requests)
      if (isTimedOut(state, 30000)) {
        transitionToIdle(cache, inputHash, state.requestId, tx);
      }
    }

    // Convert state machine state to output cells
    const currentState = getState(cache, inputHash, tx);
    pending.withTx(tx).set(currentState.type === "fetching");
    result.withTx(tx).set(
      currentState.type === "success" ? currentState.data : undefined,
    );
    partial.withTx(tx).set(
      currentState.type === "fetching" ? currentState.partial : undefined,
    );
    error.withTx(tx).set(
      currentState.type === "error" ? currentState.error : undefined,
    );

    sendResult(tx, { pending, result, partial, error });
  };
}

/**
 * Start generating an object. Uses CAS to ensure only the tab that initiated
 * the request can write the result.
 */
async function startGenerateObject<T extends Record<string, unknown>>(
  runtime: IRuntime,
  cache: Cell<Record<string, AsyncOperationCache<T, string>>>,
  inputHash: string,
  params: LLMGenerateObjectRequest,
  requestId: string,
) {
  try {
    const response = (await client.generateObject(params)) as {
      object: T;
    };

    await runtime.idle();

    // CAS: Only write if we're still the active request
    await transitionToSuccess(
      runtime,
      cache,
      inputHash,
      response.object,
      requestId,
    );
  } catch (err) {
    console.error("Error generating object", err);

    await runtime.idle();

    // CAS: Only write error if we're still the active request
    await transitionToError(
      runtime,
      cache,
      inputHash,
      err instanceof Error ? err.message : String(err),
      requestId,
    );
  }
}

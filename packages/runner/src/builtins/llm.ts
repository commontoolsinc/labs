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
import {
  buildAssistantMessage,
  buildToolCatalog,
  createToolResultMessages,
  executeToolCalls,
  extractToolCallParts,
  hasValidContent,
} from "./llm-tool-execution.ts";

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

async function executeGenerateText(params: {
  runtime: IRuntime;
  parentCell: Cell<any>;
  inputsCell: Cell<any>;
  tools: Record<string, unknown> | undefined;
  requestMessages: BuiltInLLMMessage[];
  llmParams: LLMRequest;
  hash: string;
  thisRun: number;
  currentRun: number;
  updatePartial: (text: string) => void;
  pending: Cell<boolean>;
  result: Cell<string | undefined>;
  partial: Cell<string | undefined>;
  requestHash: Cell<string | undefined>;
  onComplete: () => void;
}) {
  const {
    runtime,
    parentCell,
    inputsCell,
    tools,
    requestMessages,
    llmParams,
    hash,
    thisRun,
    currentRun,
    updatePartial,
    pending,
    result,
    partial,
    requestHash,
    onComplete,
  } = params;

  try {
    // Build tool catalog if tools are provided
    let toolCatalog: Awaited<ReturnType<typeof buildToolCatalog>> | undefined;
    if (tools && Object.keys(tools).length > 0) {
      const toolsCell = inputsCell.key("tools");
      toolCatalog = await buildToolCatalog(runtime, toolsCell);
      llmParams.tools = toolCatalog.llmTools;
    }

    // Keep track of all messages for tool calling loop
    const allMessages: BuiltInLLMMessage[] = [...requestMessages];
    let iterationCount = 0;
    const MAX_ITERATIONS = 50;

    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      if (thisRun !== currentRun) return;

      // Update params with current messages
      llmParams.messages = allMessages;

      // Make LLM request
      const llmResult = await client.sendRequest(llmParams, updatePartial);

      if (thisRun !== currentRun) return;

      // Validate content
      if (!hasValidContent(llmResult.content)) {
        throw new Error("LLM returned invalid/empty content");
      }

      // Check for tool calls
      const toolCallParts = extractToolCallParts(llmResult.content);

      if (toolCallParts.length === 0 || !toolCatalog) {
        // No tool calls - we're done
        await runtime.idle();

        const textResult = extractTextFromLLMResponse(llmResult);

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(textResult);
          partial.withTx(tx).set(textResult);
          requestHash.withTx(tx).set(hash);
        });
        return;
      }

      // Execute tool calls
      const assistantMessage = buildAssistantMessage(
        llmResult.content,
        toolCallParts,
      );
      allMessages.push(assistantMessage);

      const toolResults = await executeToolCalls(
        runtime,
        parentCell.space,
        toolCatalog,
        toolCallParts,
      );

      if (thisRun !== currentRun) return;

      // Add tool results to messages
      const toolResultMessages = createToolResultMessages(toolResults);
      allMessages.push(...toolResultMessages);

      // Continue loop to get next response
    }

    // Hit max iterations
    console.warn(`generateText hit max iterations (${MAX_ITERATIONS})`);
    await runtime.editWithRetry((tx) => {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      partial.withTx(tx).set("Error: Maximum tool call iterations exceeded");
    });
  } catch (error) {
    if (thisRun !== currentRun) return;

    console.error("Error generating text", error);

    await runtime.idle();

    await runtime.editWithRetry((tx) => {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      partial.withTx(tx).set(undefined);
    });

    // Reset previousCallHash to allow retry after error
    onComplete();
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

    executeGenerateText({
      runtime,
      parentCell,
      inputsCell,
      tools,
      requestMessages,
      llmParams,
      hash,
      thisRun,
      currentRun,
      updatePartial,
      pending,
      result,
      partial,
      requestHash,
      onComplete: () => {
        previousCallHash = undefined;
      },
    });
  };
}

async function executeGenerateObject<T extends Record<string, unknown>>(
  params: {
    runtime: IRuntime;
    parentCell: Cell<any>;
    inputsCell: Cell<any>;
    tools: Record<string, unknown> | undefined;
    requestMessages: BuiltInLLMMessage[];
    generateObjectParams: LLMGenerateObjectRequest;
    readyMetadata: Record<string, any>;
    system: string | undefined;
    model: string | undefined;
    maxTokens: number | undefined;
    hash: string;
    thisRun: number;
    currentRun: number;
    pending: Cell<boolean>;
    result: Cell<T | undefined>;
    partial: Cell<string | undefined>;
    requestHash: Cell<string | undefined>;
    onComplete: () => void;
  },
) {
  const {
    runtime,
    parentCell,
    inputsCell,
    tools,
    requestMessages,
    generateObjectParams,
    readyMetadata,
    system,
    model,
    maxTokens,
    hash,
    thisRun,
    currentRun,
    pending,
    result,
    partial,
    requestHash,
    onComplete,
  } = params;

  try {
    // Build tool catalog if tools are provided
    let toolCatalog: Awaited<ReturnType<typeof buildToolCatalog>> | undefined;
    if (tools && Object.keys(tools).length > 0) {
      const toolsCell = inputsCell.key("tools");
      toolCatalog = await buildToolCatalog(runtime, toolsCell);
    }

    // If no tools, use the simple generateObject API
    if (!toolCatalog) {
      const response = await client.generateObject(
        generateObjectParams,
      ) as { object: T };

      if (thisRun !== currentRun) return;

      await runtime.idle();

      await runtime.editWithRetry((tx) => {
        pending.withTx(tx).set(false);
        result.withTx(tx).set(response.object);
        requestHash.withTx(tx).set(hash);
      });
      return;
    }

    // With tools, use the message-based API
    const llmParams: LLMRequest = {
      system: system ?? "",
      messages: requestMessages,
      maxTokens: maxTokens ?? 8192,
      stream: false,
      model: model ?? DEFAULT_GENERATE_OBJECT_MODELS,
      metadata: {
        ...readyMetadata,
        context: "charm",
      },
      cache: true,
      tools: toolCatalog.llmTools,
      mode: "json",
    };

    const allMessages: BuiltInLLMMessage[] = [...requestMessages];
    let iterationCount = 0;
    const MAX_ITERATIONS = 50;

    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      if (thisRun !== currentRun) return;

      llmParams.messages = allMessages;

      const llmResult = await client.sendRequest(llmParams, () => {});

      if (thisRun !== currentRun) return;

      if (!hasValidContent(llmResult.content)) {
        throw new Error("LLM returned invalid/empty content");
      }

      const toolCallParts = extractToolCallParts(llmResult.content);

      if (toolCallParts.length === 0) {
        // No tool calls - parse final response as JSON
        await runtime.idle();

        const textResult = extractTextFromLLMResponse(llmResult);
        let parsedResult: T;
        try {
          parsedResult = JSON.parse(textResult) as T;
        } catch (parseError) {
          throw new Error(
            `Failed to parse LLM response as JSON: ${parseError}`,
          );
        }

        await runtime.editWithRetry((tx) => {
          pending.withTx(tx).set(false);
          result.withTx(tx).set(parsedResult);
          requestHash.withTx(tx).set(hash);
        });
        return;
      }

      // Execute tool calls
      const assistantMessage = buildAssistantMessage(
        llmResult.content,
        toolCallParts,
      );
      allMessages.push(assistantMessage);

      const toolResults = await executeToolCalls(
        runtime,
        parentCell.space,
        toolCatalog,
        toolCallParts,
      );

      if (thisRun !== currentRun) return;

      const toolResultMessages = createToolResultMessages(toolResults);
      allMessages.push(...toolResultMessages);
    }

    // Hit max iterations
    console.warn(`generateObject hit max iterations (${MAX_ITERATIONS})`);
    await runtime.editWithRetry((tx) => {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      partial.withTx(tx).set("Error: Maximum tool call iterations exceeded");
    });
  } catch (error) {
    if (thisRun !== currentRun) return;

    console.error("Error generating object", error);

    await runtime.idle();

    await runtime.editWithRetry((tx) => {
      pending.withTx(tx).set(false);
      result.withTx(tx).set(undefined);
      partial.withTx(tx).set(undefined);
    });

    // Reset previousCallHash to allow retry after error
    onComplete();
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

    resultWithLog.set({} as any); // FIXME(ja): setting result to undefined causes a storage conflict
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    executeGenerateObject({
      runtime,
      parentCell,
      inputsCell,
      tools,
      requestMessages,
      generateObjectParams,
      readyMetadata,
      system,
      model,
      maxTokens,
      hash,
      thisRun,
      currentRun,
      pending,
      result,
      partial,
      requestHash,
      onComplete: () => {
        previousCallHash = undefined;
      },
    });
  };
}

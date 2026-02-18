import { getLogger } from "@commontools/utils/logger";
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
  JSONSchema,
} from "@commontools/api";
import type { Schema } from "@commontools/api/schema";
import { refer } from "merkle-reference/json";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { llmToolExecutionHelpers } from "./llm-dialog.ts";
import {
  LLMMessageSchema,
  LLMParamsSchema,
  LLMToolSchema,
} from "./llm-schemas.ts";
import { isObject } from "@commontools/utils/types";

const logger = getLogger("llm", {
  enabled: true,
  level: "warn",
});

const client = new LLMClient();

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

const GenerateTextParamsSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    messages: { type: "array", items: LLMMessageSchema },
    context: {
      type: "object",
      additionalProperties: { asCell: true },
      default: {},
    },
    system: { type: "string" },
    model: { type: "string" },
    maxTokens: { type: "number" },
    tools: { type: "object", additionalProperties: LLMToolSchema, default: {} },
  },
} as const satisfies JSONSchema;

const GenerateObjectParamsSchema = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    messages: { type: "array", items: LLMMessageSchema },
    context: {
      type: "object",
      additionalProperties: { asCell: true },
      default: {},
    },
    schema: { type: "object" },
    system: { type: "string" },
    model: { type: "string" },
    maxTokens: { type: "number" },
    cache: { type: "boolean" },
    metadata: { type: "object" },
    tools: { type: "object", additionalProperties: LLMToolSchema },
  },
  required: ["schema"],
} as const satisfies JSONSchema;

const LLMResultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    result: {
      anyOf: [
        { type: "string" },
        { type: "array", items: { type: "object" } },
      ],
    },
    error: {},
    partial: { type: "string" },
    requestHash: { type: "string" },
  },
  required: ["pending"],
} as const satisfies JSONSchema;

const GenerateTextResultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    result: { type: "string" },
    error: {},
    partial: { type: "string" },
    requestHash: { type: "string" },
  },
  required: ["pending"],
} as const satisfies JSONSchema;

const GenerateObjectResultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    result: { type: "object" },
    error: {},
    partial: { type: "string" },
    requestHash: { type: "string" },
  },
  required: ["pending"],
} as const satisfies JSONSchema;

/** Batch interval for partial streaming updates (~15fps). */
const PARTIAL_BATCH_MS = 66;

/**
 * Creates an updatePartial callback that safely updates the partial cell
 * during streaming. Uses batched updates to reduce transaction overhead
 * while maintaining reactive updates.
 *
 * Updates are batched every PARTIAL_BATCH_MS to avoid creating many small
 * transactions during rapid streaming. Each batch waits for the scheduler
 * to be idle, then commits the latest partial text.
 *
 * Returns both the callback and a cleanup function that should be called
 * when streaming completes to clear any pending timers.
 */
function createUpdatePartialCallback(
  resultCell: Cell<any>,
  runtime: Runtime,
  getCurrentRun: () => number,
  thisRun: number,
): { callback: (text: string) => void; cleanup: () => void } {
  let pendingText: string | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let completed = false;

  const cleanup = () => {
    completed = true;
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    pendingText = null;
  };

  const callback = (text: string) => {
    if (completed || thisRun !== getCurrentRun()) {
      cleanup();
      return;
    }

    // Store the latest text (overwrites any pending update)
    pendingText = text;

    // If no batch is scheduled, start one
    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        batchTimer = null;
        const textToWrite = pendingText;
        pendingText = null;

        // Check run is still valid before committing
        if (textToWrite === null || completed || thisRun !== getCurrentRun()) {
          return;
        }

        // Wait for scheduler to be idle, then commit the batched update
        runtime.idle().then(() => {
          if (completed || thisRun !== getCurrentRun()) {
            return;
          }
          return runtime.editWithRetry((tx) => {
            const partialCell = resultCell.key("partial").withTx(tx);
            partialCell.set(textToWrite);
          });
        }).catch((e) => {
          console.warn("[LLM] Error writing partial update:", e);
        });
      }, PARTIAL_BATCH_MS);
    }
  };

  return { callback, cleanup };
}

/**
 * Common tool execution loop shared between llm, generateText, and generateObject.
 * Handles the recursive tool calling pattern where the LLM can call tools,
 * receive results, and continue the conversation.
 */
async function executeWithToolsLoop(params: {
  initialMessages: readonly BuiltInLLMMessage[];
  llmParams: LLMRequest;
  toolCatalog: ReturnType<typeof llmToolExecutionHelpers.buildToolCatalog>;
  updatePartial: (text: string) => void;
  runtime: Runtime;
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
    currentMessages: readonly BuiltInLLMMessage[],
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
  runtime: Runtime,
  pendingCell: Cell<boolean>,
  resultCell: Cell<T>,
  errorCell: Cell<unknown>,
  partialCell: Cell<P>,
  requestHashCell: Cell<string | undefined>,
  requestHash: string,
  getCurrentRun: () => number,
  thisRun: number,
  resetPreviousHash: () => void,
): Promise<void> {
  if (thisRun !== getCurrentRun()) return;

  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[LLM Error] ${message}`);
  logger.warn("llm", "Error in LLM request", { error });

  await runtime.idle();

  await runtime.editWithRetry((tx) => {
    pendingCell.withTx(tx).set(false);
    errorCell.withTx(tx).set(error);
    resultCell.withTx(tx).set(undefined as T);
    partialCell.withTx(tx).set(undefined as P);
    requestHashCell.withTx(tx).set(requestHash);
  });

  resetPreviousHash();
}

/**
 * Helper function to build context documentation from context cells.
 * Used by llm, generateText, and generateObject to provide consistent
 * context handling across all LLM builtins.
 *
 * @param inputs - The inputs cell containing the context parameter
 * @param runtime - The runtime instance
 * @param space - The memory space
 * @param tx - The current transaction
 * @returns Context documentation string to append to system prompt
 */
function buildContextDocumentation(
  inputs: Cell<any>,
  runtime: Runtime,
  space: any,
  tx: IExtendedStorageTransaction,
): string {
  const context = inputs.key("context").withTx(tx).get();
  if (!context) return "";

  // Create empty pinned cells array with proper schema
  const pinnedCellsSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
      },
      required: ["path", "name"],
    },
  } as const;

  return llmToolExecutionHelpers.buildAvailableCellsDocumentation(
    runtime,
    space,
    context,
    // LLM builtins don't have pinned cells (only llmDialog does)
    runtime.getCell(
      space,
      { llm: { pinnedCells: [] } },
      pinnedCellsSchema,
      tx,
    ),
  );
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
  runtime: Runtime, // Runtime will be injected by the registration function
): Action {
  const inputs = inputsCell.asSchema(LLMParamsSchema);

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let resultCell: Cell<Schema<typeof LLMResultSchema>>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      resultCell = runtime.getCell(
        parentCell.space,
        { llm: { result: cause } },
        LLMResultSchema,
        tx,
      );
      resultCell.sync();
      sendResult(tx, resultCell);
      cellsInitialized = true;
    }

    const thisRun = ++currentRun;
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    const { system, messages, stop, maxTokens, model } = inputs.withTx(tx)
      .get();

    // Build context documentation from context cells and append to system prompt
    const contextDocs = buildContextDocumentation(
      inputs,
      runtime,
      parentCell.space,
      tx,
    );

    const llmParams: LLMRequest = {
      system: (system ?? "") + contextDocs,
      messages: (messages as unknown as readonly BuiltInLLMMessage[]) ?? [],
      stop: stop ?? "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        // FIXME(ja): how do we get the context of space/piece id here
        // bf: I also do not know... this one is tricky
        context: "piece",
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
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    resultWithLog.set(undefined);
    errorWithLog.set(undefined);
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    const { callback: updatePartial, cleanup: cleanupPartial } =
      createUpdatePartialCallback(
        resultCell,
        runtime,
        () => currentRun,
        thisRun,
      );

    // Build tool catalog if tools are present, then start execution
    const resultPromise = (async () => {
      try {
        const toolsCell = inputs.key("tools").asSchema({
          type: "object",
          additionalProperties: LLMToolSchema,
        });
        const toolCatalog = toolsCell
          ? llmToolExecutionHelpers.buildToolCatalog(toolsCell)
          : undefined;

        await executeWithToolsLoop({
          initialMessages:
            (messages as unknown as readonly BuiltInLLMMessage[]) ?? [],
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
              resultCell.key("pending").withTx(tx).set(false);
              resultCell.key("result").withTx(tx).set(llmResult.content);
              resultCell.key("error").withTx(tx).set(undefined);
              resultCell.key("partial").withTx(tx).set(
                extractTextFromLLMResponse(llmResult),
              );
              resultCell.key("requestHash").withTx(tx).set(hash);
            });
          },
        });
      } finally {
        cleanupPartial();
      }
    })();

    resultPromise.catch((e) =>
      handleLLMError(
        e,
        runtime,
        resultCell.key("pending"),
        resultCell.key("result"),
        resultCell.key("error"),
        resultCell.key("partial"),
        resultCell.key("requestHash"),
        hash,
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
  runtime: Runtime,
): Action {
  const inputs = inputsCell.asSchema(GenerateTextParamsSchema);

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let resultCell: Cell<Schema<typeof GenerateTextResultSchema>>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      resultCell = runtime.getCell(
        parentCell.space,
        { generateText: { result: cause } },
        GenerateTextResultSchema,
        tx,
      );
      resultCell.sync();
      sendResult(tx, resultCell);
      cellsInitialized = true;
    }
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    const { system, prompt, messages, model, maxTokens } = inputs.withTx(tx)
      .get();

    // If neither prompt nor messages is provided, don't make a request
    if (!prompt && !messages) {
      resultWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    // Convert prompt to messages if provided, otherwise use messages directly
    const requestMessages: readonly BuiltInLLMMessage[] =
      (messages as unknown as readonly BuiltInLLMMessage[]) ||
      [{ role: "user", content: prompt! }];

    // Build context documentation from context cells and append to system prompt
    const contextDocs = buildContextDocumentation(
      inputs,
      runtime,
      parentCell.space,
      tx,
    );

    const llmParams: LLMRequest = {
      system: (system ?? "") + contextDocs,
      messages: requestMessages,
      stop: "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        context: "piece",
      },
      cache: true,
      // tools will be added below if present
    };

    const hash = refer(llmParams).toString();
    const currentRequestHash = requestHashWithLog.get();
    const currentResult = resultWithLog.get();
    const currentError = errorWithLog.get();

    // Return if the same request is being made again
    // Also return if there's an error for this request (don't retry automatically)
    if (
      (currentResult !== undefined || currentError !== undefined) &&
      hash === currentRequestHash
    ) {
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
    errorWithLog.set(undefined);
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    const { callback: updatePartial, cleanup: cleanupPartial } =
      createUpdatePartialCallback(
        resultCell,
        runtime,
        () => currentRun,
        thisRun,
      );

    // Build tool catalog if tools are present, then start execution
    const resultPromise = (async () => {
      try {
        const toolsCell = inputs.key("tools").asSchema({
          type: "object",
          additionalProperties: LLMToolSchema,
        });
        const toolCatalog = toolsCell
          ? llmToolExecutionHelpers.buildToolCatalog(toolsCell)
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
              resultCell.key("pending").withTx(tx).set(false);
              resultCell.key("result").withTx(tx).set(textResult);
              resultCell.key("error").withTx(tx).set(undefined);
              resultCell.key("partial").withTx(tx).set(textResult);
              resultCell.key("requestHash").withTx(tx).set(hash);
            });
          },
        });
      } finally {
        cleanupPartial();
      }
    })();

    resultPromise.catch((e) =>
      handleLLMError(
        e,
        runtime,
        resultCell.key("pending"),
        resultCell.key("result"),
        resultCell.key("error"),
        resultCell.key("partial"),
        resultCell.key("requestHash"),
        hash,
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
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  const inputs = inputsCell.asSchema(GenerateObjectParamsSchema);

  let currentRun = 0;
  let previousCallHash: string | undefined = undefined;
  let cellsInitialized = false;
  let resultCell: Cell<Schema<typeof GenerateObjectResultSchema>>;

  return (tx: IExtendedStorageTransaction) => {
    if (!cellsInitialized) {
      resultCell = runtime.getCell(
        parentCell.space,
        { generateObject: { result: cause } },
        GenerateObjectResultSchema,
        tx,
      );
      resultCell.sync();
      sendResult(tx, resultCell);
      cellsInitialized = true;
    }
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    const {
      prompt,
      messages,
      maxTokens,
      model,
      schema,
      system,
      cache,
      tools,
      metadata,
    } = inputs.withTx(tx).get() ?? {};

    if ((!prompt && (!messages || messages.length === 0)) || !schema) {
      resultWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    const readyMetadata = metadata ? JSON.parse(JSON.stringify(metadata)) : {};

    // Convert prompt to messages if provided, otherwise use messages directly
    const requestMessages: readonly BuiltInLLMMessage[] =
      (messages as unknown as readonly BuiltInLLMMessage[]) ||
      [{ role: "user", content: prompt! }];

    // Build context documentation from context cells and append to system prompt
    const contextDocs = buildContextDocumentation(
      inputs,
      runtime,
      parentCell.space,
      tx,
    );

    // Determine whether to use the tool-calling path or the direct generateObject path
    const hasTools = isObject(tools) && Object.keys(tools).length > 0;

    if (hasTools) {
      // Use tool-calling path with finalResult builtin tool
      const llmParams: LLMRequest = {
        system: (system ?? "") + contextDocs,
        messages: requestMessages,
        stop: "",
        maxTokens: maxTokens ?? 8192,
        stream: true,
        model: model ?? DEFAULT_GENERATE_OBJECT_MODELS,
        metadata: {
          ...readyMetadata,
          context: "piece",
        },
        cache: cache ?? true,
      };

      const hash = refer({ ...llmParams, schema }).toString();
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();
      const currentError = errorWithLog.get();

      // Return if the same request is being made again
      // Also return if there's an error for this request (don't retry automatically)
      if (
        (currentResult !== undefined || currentError !== undefined) &&
        hash === currentRequestHash
      ) {
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
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(true);

      const { callback: updatePartial, cleanup: cleanupPartial } =
        createUpdatePartialCallback(
          resultCell,
          runtime,
          () => currentRun,
          thisRun,
        );

      // Build tool catalog with finalResult tool
      const resultPromise = (async () => {
        try {
          const toolsCell = inputs.key("tools").asSchema({
            type: "object",
            additionalProperties: LLMToolSchema,
          });
          const baseCatalog = llmToolExecutionHelpers.buildToolCatalog(
            toolsCell,
          );

          // Add presentResult builtin tool
          const toolCatalog = {
            ...baseCatalog,
            llmTools: {
              ...baseCatalog.llmTools,
              [llmToolExecutionHelpers.PRESENT_RESULT_TOOL_NAME]: {
                description:
                  "Call this tool with the final structured result matching the required schema. This should be your last action.",
                inputSchema: JSON.parse(JSON.stringify(schema)),
              },
            },
          };

          // Execute with tools - capture presentResult when called
          let finalResult: T | undefined;

          // Custom execution loop for generateObject with presentResult extraction
          const executeRecursive = async (
            currentMessages: readonly BuiltInLLMMessage[],
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

              const toolResults = await llmToolExecutionHelpers
                .executeToolCalls(
                  runtime,
                  parentCell.space,
                  toolCatalog,
                  toolCallParts,
                );

              // Check if presentResult was called. Cellify from the raw
              // tool call input to get live Cell references (the tool result
              // itself is serialized with @link for the conversation).
              const presentResultPart = toolCallParts.find(
                (p) =>
                  p.toolName ===
                    llmToolExecutionHelpers.PRESENT_RESULT_TOOL_NAME,
              );
              if (presentResultPart) {
                finalResult = llmToolExecutionHelpers.traverseAndCellify(
                  runtime,
                  parentCell.space,
                  presentResultPart.input,
                ) as T;
              }

              const toolResultMessages = llmToolExecutionHelpers
                .createToolResultMessages(toolResults);

              const updatedMessages = [
                ...currentMessages,
                assistantMessage,
                ...toolResultMessages,
              ];

              // Continue if presentResult wasn't called yet
              if (!presentResultPart) {
                await executeRecursive(updatedMessages);
              }
            } else {
              throw new Error(
                "LLM did not call presentResult tool with structured data",
              );
            }
          };

          await executeRecursive(requestMessages);

          if (finalResult === undefined) {
            throw new Error("presentResult was never called");
          }

          return finalResult;
        } finally {
          cleanupPartial();
        }
      })();

      resultPromise
        .then(async (objectResult) => {
          if (thisRun !== currentRun) return;

          await runtime.idle();

          await runtime.editWithRetry((tx) => {
            resultCell.key("pending").withTx(tx).set(false);
            resultCell.key("result").withTx(tx).set(objectResult);
            resultCell.key("error").withTx(tx).set(undefined);
            resultCell.key("requestHash").withTx(tx).set(hash);
          });
        })
        .catch((e) =>
          handleLLMError(
            e,
            runtime,
            resultCell.key("pending"),
            resultCell.key("result"),
            resultCell.key("error"),
            resultCell.key("partial"),
            resultCell.key("requestHash"),
            hash,
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
          context: "piece",
        },
        cache: cache ?? true,
      };

      // Always set system prompt with context documentation
      generateObjectParams.system = (system ?? "") + contextDocs;

      const hash = refer(generateObjectParams).toString();
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();
      const currentError = errorWithLog.get();

      // Return if the same request is being made again
      // Also return if there's an error for this request (don't retry automatically)
      if (
        (currentResult !== undefined || currentError !== undefined) &&
        hash === currentRequestHash
      ) {
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
      errorWithLog.set(undefined);
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
            resultCell.key("pending").withTx(tx).set(false);
            resultCell.key("result").withTx(tx).set(response.object);
            resultCell.key("error").withTx(tx).set(undefined);
            resultCell.key("requestHash").withTx(tx).set(hash);
          });
        })
        .catch((e) =>
          handleLLMError(
            e,
            runtime,
            resultCell.key("pending"),
            resultCell.key("result"),
            resultCell.key("error"),
            resultCell.key("partial"),
            resultCell.key("requestHash"),
            hash,
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

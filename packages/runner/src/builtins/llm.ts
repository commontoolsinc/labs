import { getLogger } from "@commonfabric/utils/logger";
import {
  DEFAULT_GENERATE_OBJECT_MODELS,
  DEFAULT_MODEL_NAME,
  extractTextFromLLMResponse,
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  LLMClient,
  LLMGenerateObjectRequest,
  type LLMNativeModelToolId,
  LLMRequest,
  LLMResponse,
} from "@commonfabric/llm";
import {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInLLMMessage,
  BuiltInLLMParams,
  JSONSchema,
} from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { toDeepFrozenSchema } from "@commonfabric/data-model/schema-utils";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { cfcLabelViewForCellFailClosed } from "../cfc/label-view.ts";
import {
  schemaWithInjectionSafeAnnotations,
  validateAgainstSchema,
} from "../cfc/schema-sanitization.ts";
import { uniqueCfcAtoms } from "../cfc/observation.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { type Cell, isCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import { llmToolExecutionHelpers } from "./llm-dialog.ts";
import { scopedCell } from "./scope-policy.ts";
import {
  GenerateObjectParamsSchema,
  GenerateObjectResultSchema,
  GenerateTextParamsSchema,
  GenerateTextResultSchema,
  LLMParamsSchema,
  LLMResultSchema,
  LLMToolSchema,
} from "./llm-schemas.ts";
import { isObject, isRecord } from "@commonfabric/utils/types";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";

const logger = getLogger("llm", {
  enabled: true,
  level: "warn",
});

const client = new LLMClient();

// TODO(ja): investigate if generateText should be replaced by
// fetchData with streaming support

/** Batch interval for partial streaming updates (~15fps). */
const PARTIAL_BATCH_MS = 66;

function logGenerateObject(stage: string, details: Record<string, unknown>) {
  console.warn("[generateObject]", stage, details);
}

function summarizeGenerateObjectRequest(details: {
  hash: string;
  path: "direct" | "tools";
  model?: string;
  hasTools: boolean;
  toolNames?: string[];
  messageCount: number;
  contextKeys?: string[];
  queueName?: string;
}) {
  return {
    hash: details.hash.slice(0, 12),
    path: details.path,
    model: details.model,
    hasTools: details.hasTools,
    toolNames: details.toolNames ?? [],
    messageCount: details.messageCount,
    contextKeys: details.contextKeys ?? [],
    queueName: details.queueName,
  };
}

function collectCellConfidentiality(cell: Cell<any>): readonly unknown[] {
  const labelView = cfcLabelViewForCellFailClosed(cell.resolveAsCell());
  if (labelView === undefined) {
    return [];
  }

  return uniqueCfcAtoms(
    labelView.entries.flatMap((entry) => entry.label.confidentiality ?? []),
  );
}

function collectGenerateObjectPromptConfidentiality(
  inputs: Cell<any>,
): readonly unknown[] {
  return uniqueCfcAtoms([
    ...collectCellConfidentiality(inputs.key("prompt")),
    ...collectCellConfidentiality(inputs.key("messages")),
    ...collectCellConfidentiality(inputs.key("system")),
  ]);
}

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
  toolCatalog?:
    | ReturnType<typeof llmToolExecutionHelpers.buildToolCatalog>
    | undefined;
  initialObservedConfidentiality?: readonly unknown[];
  observationMaxConfidentiality?: readonly unknown[];
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
    initialObservedConfidentiality = [],
    observationMaxConfidentiality,
    updatePartial,
    runtime,
    space,
    getCurrentRun,
    thisRun,
    onComplete,
  } = params;

  const executeRecursive = async (
    currentMessages: readonly BuiltInLLMMessage[],
    observedConfidentiality: readonly unknown[],
  ): Promise<void> => {
    if (thisRun !== getCurrentRun()) return;

    const requestParams: LLMRequest = {
      ...llmParams,
      messages: currentMessages,
    };
    if (toolCatalog && requestParams.tools === undefined) {
      requestParams.tools = toolCatalog.llmTools;
    }

    // Route the call to the executing space's host when the space is
    // host-mapped (one runtime spans hosts; an LLM call belongs to the
    // space whose pattern made it). An UNMAPPED space keeps the
    // module-level default endpoint — like fetch-data, hostForSpace's
    // apiUrl fallback is NOT used, because deployments may split the
    // pattern-facing api host from the runtime's memory host.
    const mappedLlmHost = runtime.mappedHostFor(space);
    const llmResult = await client.sendRequest(
      requestParams,
      updatePartial,
      undefined,
      mappedLlmHost
        ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
        : undefined,
    );

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
        undefined,
        observedConfidentiality,
        observationMaxConfidentiality,
      );

      const toolResultMessages = llmToolExecutionHelpers
        .createToolResultMessages(toolResults);

      const updatedMessages = [
        ...currentMessages,
        assistantMessage,
        ...toolResultMessages,
      ];

      const nextObservedConfidentiality = uniqueCfcAtoms([
        ...observedConfidentiality,
        ...toolResults.flatMap((result) =>
          result.observedConfidentiality ?? []
        ),
      ]);

      await executeRecursive(updatedMessages, nextObservedConfidentiality);
    } else {
      // No more tool calls, finish
      await onComplete(llmResult);
    }
  };

  await executeRecursive(
    params.initialMessages,
    initialObservedConfidentiality,
  );
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
  sink: string,
): { docs: string; observedConfidentiality: readonly unknown[] } {
  const context = inputs.key("context").withTx(tx).get();
  if (!context) {
    return {
      docs: "",
      observedConfidentiality: [],
    };
  }

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

  return llmToolExecutionHelpers
    .buildAvailableCellsDocumentationWithObservation(
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
      // Bound the pattern-supplied ceiling by the deployment ceiling for this
      // sink so neither the context docs nor the tool loop observe past it
      // (#3993 review).
      llmToolExecutionHelpers.effectiveObservationCeiling(
        runtime,
        sink,
        inputs.key("observationMaxConfidentiality").withTx(tx).get() as
          | readonly unknown[]
          | undefined,
      ),
    );
}

function enqueuePostCommitLLMWork(
  tx: IExtendedStorageTransaction,
  sink: string,
  id: string,
  kind: string,
  request: any,
  start: () => void,
): void {
  enqueueSinkRequestPostCommitEffect(
    tx,
    sink,
    id,
    request,
    kind,
    () => {
      start();
    },
  );
}

function markRequestHashPendingCommit(
  tx: IExtendedStorageTransaction,
  hash: string,
  getPreviousCallHash: () => string | undefined,
  setPreviousCallHash: (hash: string | undefined) => void,
): void {
  const previousCallHash = getPreviousCallHash();
  setPreviousCallHash(hash);
  tx.addCommitCallback((_committedTx, commitResult) => {
    if (commitResult.error && getPreviousCallHash() === hash) {
      setPreviousCallHash(previousCallHash);
    }
  });
}

async function pullContextCells(
  context: Record<string, unknown> | undefined,
) {
  for (const value of Object.values(context ?? {})) {
    try {
      const resolved = isCellResultForDereferencing(value)
        ? getCellOrThrow(value).resolveAsCell()
        : isCell(value)
        ? value.resolveAsCell()
        : isRecord(value) && typeof value.resolveAsCell === "function"
        ? value.resolveAsCell()
        : undefined;
      await resolved?.pull?.();
    } catch {
      // Ignore unresolved context cells and let request construction continue.
    }
  }
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
  let cellScope: CellScope | undefined;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const {
      system,
      messages,
      stop,
      maxTokens,
      model,
      search,
      nativeModelToolIds,
    } = inputs.withTx(tx).get();
    const effectiveNativeModelToolIds = resolveNativeModelToolIds(
      search,
      nativeModelToolIds,
    );

    // Build context documentation from context cells and append to system prompt
    const contextDocs = buildContextDocumentation(
      inputs,
      runtime,
      parentCell.space,
      tx,
      "llm",
    );
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCallHash = undefined;
      }
      const baseResultCell = runtime.getCell(
        parentCell.space,
        { llm: { result: cause } },
        LLMResultSchema,
        tx,
      );
      resultCell = scopedCell(runtime, tx, baseResultCell, outputScope);
      resultCell.sync();
      sendResult(tx, resultCell);
      cellsInitialized = true;
      cellScope = outputScope;
    }

    const thisRun = ++currentRun;
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    const llmParams: LLMRequest = {
      system: ((system ?? "") + contextDocs.docs).trim() ||
        "You are a helpful assistant.",
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
      ...(effectiveNativeModelToolIds
        ? { nativeModelToolIds: effectiveNativeModelToolIds }
        : {}),
      // tools will be added below if present
    };

    const toolsCell = inputs.key("tools").asSchema({
      type: "object",
      additionalProperties: LLMToolSchema,
    });
    const toolCatalog = toolsCell
      ? llmToolExecutionHelpers.buildToolCatalog(toolsCell)
      : undefined;
    const requestSnapshot = createFrozenRequestSnapshot(
      toolCatalog ? { ...llmParams, tools: toolCatalog.llmTools } : llmParams,
    );
    const hash = hashOf(requestSnapshot).toString();
    const queueName = inputs.key("queue").withTx(tx).get() as unknown as
      | string
      | undefined;

    // Return if the same request is being made again, either concurrently (same
    // as previousCallHash) or when rehydrated from storage (same as the
    // contents of the requestHash doc).
    if (hash === previousCallHash || hash === requestHashWithLog.get()) return;

    if (!Array.isArray(messages) || messages.length === 0) {
      resultWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      pendingWithLog.set(false);
      return;
    }

    markRequestHashPendingCommit(
      tx,
      hash,
      () => previousCallHash,
      (next) => {
        previousCallHash = next;
      },
    );

    resultWithLog.set(undefined);
    errorWithLog.set(undefined);
    partialWithLog.set(undefined);
    pendingWithLog.set(true);

    // When queued, disable run cancellation — the queue manages lifecycle.
    const getRunForCancellation = queueName ? () => thisRun : () => currentRun;

    const { callback: updatePartial, cleanup: cleanupPartial } =
      createUpdatePartialCallback(
        resultCell,
        runtime,
        getRunForCancellation,
        thisRun,
      );

    // Build tool catalog if tools are present, then start execution after the
    // transaction commits.
    enqueuePostCommitLLMWork(
      tx,
      "llm",
      `llm:${hash}`,
      "llm-start",
      requestSnapshot,
      () => {
        const resultPromise = (async () => {
          try {
            const doWork = () =>
              executeWithToolsLoop({
                initialMessages:
                  (messages as unknown as readonly BuiltInLLMMessage[]) ??
                    [],
                llmParams: requestSnapshot,
                toolCatalog,
                initialObservedConfidentiality:
                  contextDocs.observedConfidentiality,
                // Deployment-bounded so post-commit tool reads can't exceed the
                // llm sink ceiling (#3993 review).
                observationMaxConfidentiality: llmToolExecutionHelpers
                  .effectiveObservationCeiling(
                    runtime,
                    "llm",
                    inputs.key("observationMaxConfidentiality").get() as
                      | readonly unknown[]
                      | undefined,
                  ),
                updatePartial,
                runtime,
                space: parentCell.space,
                getCurrentRun: getRunForCancellation,
                thisRun,
                onComplete: async (llmResult) => {
                  // Skip if a newer request has already superseded this one.
                  if (hash !== previousCallHash) return;

                  await runtime.idle();
                  const groundingSources = extractGroundingSources(llmResult);

                  await runtime.editWithRetry((tx) => {
                    resultCell.key("pending").withTx(tx).set(false);
                    resultCell.key("result").withTx(tx).set(llmResult.content);
                    resultCell.key("error").withTx(tx).set(undefined);
                    resultCell.key("partial").withTx(tx).set(
                      extractTextFromLLMResponse(llmResult),
                    );
                    resultCell.key("requestHash").withTx(tx).set(hash);
                    resultCell.key("groundingSources").withTx(tx).set(
                      groundingSources,
                    );
                  });
                },
              });

            if (queueName) {
              await runtime.getOrCreateQueue(queueName).enqueue(doWork);
            } else {
              await doWork();
            }
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
            getRunForCancellation,
            thisRun,
            () => {
              // Only clear if this is still the current request; a newer request
              // may have already set previousCallHash to its own hash.
              if (hash === previousCallHash) previousCallHash = undefined;
            },
          )
        );
      },
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
/**
 * Resolve the effective native-model-tool ids for a request from the friendly
 * `search` flag (shorthand for Google Search grounding) plus any explicit
 * `nativeModelToolIds`. Returns undefined when none are requested.
 */
function resolveNativeModelToolIds(
  search: unknown,
  nativeModelToolIds: unknown,
): readonly LLMNativeModelToolId[] | undefined {
  const ids: string[] = [];
  if (search === true) ids.push(GOOGLE_SEARCH_NATIVE_MODEL_TOOL);
  if (Array.isArray(nativeModelToolIds)) {
    for (const id of nativeModelToolIds) {
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.length > 0 ? (ids as readonly LLMNativeModelToolId[]) : undefined;
}

/**
 * Flatten grounding/source URLs out of an LLM response's
 * `nativeModelToolResults[].sources` (e.g. from `google_search`) into the
 * compact `{ url, title, snippet }[]` shape surfaced on builtin result state.
 */
function extractGroundingSources(
  llmResult: LLMResponse,
): Array<{ url?: string; title?: string; snippet?: string }> | undefined {
  const results =
    (llmResult as { nativeModelToolResults?: readonly { sources?: unknown }[] })
      .nativeModelToolResults;
  if (!Array.isArray(results) || results.length === 0) return undefined;
  const out: Array<{ url?: string; title?: string; snippet?: string }> = [];
  const seen = new Set<string>();
  for (const r of results) {
    const sources = r?.sources;
    if (!Array.isArray(sources)) continue;
    for (const s of sources) {
      if (!s || typeof s !== "object") continue;
      const rec = s as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url : undefined;
      const title = typeof rec.title === "string" ? rec.title : undefined;
      const snippet = typeof rec.snippet === "string"
        ? rec.snippet
        : typeof rec.description === "string"
        ? rec.description
        : undefined;
      const key = url ?? title ?? JSON.stringify(rec);
      if (seen.has(key)) continue;
      seen.add(key);
      if (url || title || snippet) out.push({ url, title, snippet });
    }
  }
  return out.length > 0 ? out : undefined;
}

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
  let cellScope: CellScope | undefined;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
    const {
      system,
      prompt,
      messages,
      model,
      maxTokens,
      search,
      nativeModelToolIds,
    } = inputs.withTx(tx).get();
    const effectiveNativeModelToolIds = resolveNativeModelToolIds(
      search,
      nativeModelToolIds,
    );

    // Build context documentation from context cells and append to system prompt
    const contextDocs = buildContextDocumentation(
      inputs,
      runtime,
      parentCell.space,
      tx,
      "generateText",
    );
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCallHash = undefined;
      }
      const baseResultCell = runtime.getCell(
        parentCell.space,
        { generateText: { result: cause } },
        GenerateTextResultSchema,
        tx,
      );
      resultCell = scopedCell(runtime, tx, baseResultCell, outputScope);
      resultCell.sync();
      sendResult(tx, resultCell);
      cellsInitialized = true;
      cellScope = outputScope;
    }
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    // If neither prompt nor messages is provided, don't make a request
    const hasPrompt = Array.isArray(prompt) ? prompt.length > 0 : !!prompt;
    if (!hasPrompt && !messages) {
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

    const llmParams: LLMRequest = {
      system: ((system ?? "") + contextDocs.docs).trim() ||
        "You are a helpful assistant.",
      messages: requestMessages,
      stop: "",
      maxTokens: maxTokens ?? 4096,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: {
        context: "piece",
      },
      cache: true,
      ...(effectiveNativeModelToolIds
        ? { nativeModelToolIds: effectiveNativeModelToolIds }
        : {}),
      // tools will be added below if present
    };

    const toolsCell = inputs.key("tools").asSchema({
      type: "object",
      additionalProperties: LLMToolSchema,
    });
    const toolCatalog = toolsCell
      ? llmToolExecutionHelpers.buildToolCatalog(toolsCell)
      : undefined;
    const requestSnapshot = createFrozenRequestSnapshot(
      toolCatalog ? { ...llmParams, tools: toolCatalog.llmTools } : llmParams,
    );
    const hash = hashOf(requestSnapshot).toString();
    const queueName = inputs.key("queue").withTx(tx).get() as unknown as
      | string
      | undefined;
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

    markRequestHashPendingCommit(
      tx,
      hash,
      () => previousCallHash,
      (next) => {
        previousCallHash = next;
      },
    );

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

    // When queued, disable run cancellation — the queue manages lifecycle.
    // Once enqueued, the job must run to completion to avoid abandoning
    // HTTP streams (which causes ERR_INCOMPLETE_CHUNK_ENCODING).
    const getRunForCancellation = queueName ? () => thisRun : () => currentRun;

    const { callback: updatePartial, cleanup: cleanupPartial } =
      createUpdatePartialCallback(
        resultCell,
        runtime,
        getRunForCancellation,
        thisRun,
      );

    enqueuePostCommitLLMWork(
      tx,
      "generateText",
      `generateText:${hash}`,
      "generateText-start",
      requestSnapshot,
      () => {
        const resultPromise = (async () => {
          try {
            const doWork = () =>
              executeWithToolsLoop({
                initialMessages: requestMessages,
                llmParams: requestSnapshot,
                toolCatalog,
                initialObservedConfidentiality:
                  contextDocs.observedConfidentiality,
                // Deployment-bounded so post-commit tool reads can't exceed the
                // generateText sink ceiling (#3993 review).
                observationMaxConfidentiality: llmToolExecutionHelpers
                  .effectiveObservationCeiling(
                    runtime,
                    "generateText",
                    inputs.key("observationMaxConfidentiality").get() as
                      | readonly unknown[]
                      | undefined,
                  ),
                updatePartial,
                runtime,
                space: parentCell.space,
                getCurrentRun: getRunForCancellation,
                thisRun,
                onComplete: async (llmResult) => {
                  await runtime.idle();

                  const textResult = extractTextFromLLMResponse(llmResult);
                  const groundingSources = extractGroundingSources(llmResult);

                  await runtime.editWithRetry((tx) => {
                    resultCell.key("pending").withTx(tx).set(false);
                    resultCell.key("result").withTx(tx).set(textResult);
                    resultCell.key("error").withTx(tx).set(undefined);
                    resultCell.key("partial").withTx(tx).set(textResult);
                    resultCell.key("requestHash").withTx(tx).set(hash);
                    resultCell.key("groundingSources").withTx(tx).set(
                      groundingSources,
                    );
                  });
                },
              });

            if (queueName) {
              await runtime.getOrCreateQueue(queueName).enqueue(doWork);
            } else {
              await doWork();
            }
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
            getRunForCancellation,
            thisRun,
            () => {
              // Only clear if this is still the current request; a newer request
              // may have already set previousCallHash to its own hash.
              if (hash === previousCallHash) previousCallHash = undefined;
            },
          )
        );
      },
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
  let cellScope: CellScope | undefined;

  return (tx: IExtendedStorageTransaction) => {
    tx.resetNarrowestReadScope();
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
      schemaSanitizePromptInjection,
      search,
      nativeModelToolIds,
    } = inputs.withTx(tx).get() ?? {};
    const effectiveNativeModelToolIds = resolveNativeModelToolIds(
      search,
      nativeModelToolIds,
    );
    const context = inputs.key("context").withTx(tx).get() as
      | Record<string, unknown>
      | undefined;
    // Bound the pattern-supplied ceiling by the deployment generateObject
    // ceiling once here; every downstream consumer (context docs, the tools
    // loop, and the direct path) inherits the effective bound, so post-commit
    // tool reads can't observe past the deployment ceiling (#3993 review).
    const observationMaxConfidentiality = llmToolExecutionHelpers
      .effectiveObservationCeiling(
        runtime,
        "generateObject",
        inputs.key("observationMaxConfidentiality").withTx(tx).get() as
          | readonly unknown[]
          | undefined,
      );
    const outputScope = tx.getNarrowestReadScope();

    if (!cellsInitialized || cellScope !== outputScope) {
      if (cellsInitialized && cellScope !== outputScope) {
        previousCallHash = undefined;
      }
      const baseResultCell = runtime.getCell(
        parentCell.space,
        { generateObject: { result: cause } },
        GenerateObjectResultSchema,
        tx,
      );
      resultCell = scopedCell(runtime, tx, baseResultCell, outputScope);
      resultCell.sync();
      sendResult(tx, resultCell);
      cellsInitialized = true;
      cellScope = outputScope;
    }
    const pendingWithLog = resultCell.key("pending").withTx(tx);
    const resultWithLog = resultCell.key("result").withTx(tx);
    const messagesWithLog = resultCell.key("messages").withTx(tx);
    const errorWithLog = resultCell.key("error").withTx(tx);
    const partialWithLog = resultCell.key("partial").withTx(tx);
    const requestHashWithLog = resultCell.key("requestHash").withTx(tx);

    const hasPrompt = Array.isArray(prompt) ? prompt.length > 0 : !!prompt;
    if (
      (!hasPrompt && (!messages || messages.length === 0)) ||
      schema === undefined
    ) {
      resultWithLog.set(undefined);
      messagesWithLog.set(undefined);
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
    const contextDocs = context
      ? llmToolExecutionHelpers.buildAvailableCellsDocumentationWithObservation(
        runtime,
        parentCell.space,
        context as Record<string, Cell<any>>,
        runtime.getCell(
          parentCell.space,
          { generateObject: { pinnedCells: [] } },
          pinnedCellsSchema,
          tx,
        ),
        observationMaxConfidentiality,
      )
      : {
        docs: "",
        observedConfidentiality: [],
      };
    // Determine whether to use the tool-calling path or the direct generateObject path
    const hasTools = isObject(tools) && Object.keys(tools).length > 0;
    const validationSchema = schemaSanitizePromptInjection
      ? toDeepFrozenSchema(schema)
      : undefined;
    const resultSchemaForObserved = (
      observedConfidentiality: readonly unknown[],
    ) =>
      schemaSanitizePromptInjection
        ? schemaWithInjectionSafeAnnotations(
          validationSchema as any,
          observedConfidentiality,
        )
        : undefined;
    const validateResultForSchemaSanitization = (value: unknown): void => {
      if (validationSchema === undefined) {
        return;
      }
      const failure = validateAgainstSchema(validationSchema, value);
      if (failure !== undefined) {
        throw new Error(
          `generateObject result failed schema sanitization validation: ${failure}`,
        );
      }
    };

    if (hasTools) {
      // Use tool-calling path with presentResult builtin tool
      const llmParams: LLMRequest = {
        system: ((system ?? "") + contextDocs.docs).trim() ||
          "You are a helpful assistant.",
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
        ...(effectiveNativeModelToolIds
          ? { nativeModelToolIds: effectiveNativeModelToolIds }
          : {}),
      };

      const toolsCell = inputs.key("tools").asSchema({
        type: "object",
        additionalProperties: LLMToolSchema,
      });
      const baseCatalog = llmToolExecutionHelpers.buildToolCatalog(
        toolsCell,
      );

      // Add presentResult builtin tool.
      const toolCatalog = {
        ...baseCatalog,
        llmTools: {
          ...baseCatalog.llmTools,
          [llmToolExecutionHelpers.PRESENT_RESULT_TOOL_NAME]: {
            description:
              "Call this tool with the final structured result matching the required schema. This should be your last action.",
            inputSchema: llmToolExecutionHelpers.prepareSchemaForLLM(
              toDeepFrozenSchema(schema),
            ),
          },
        },
      };
      const llmParamsWithTools: LLMRequest = {
        ...llmParams,
        tools: toolCatalog.llmTools,
      };
      const requestSnapshot = createFrozenRequestSnapshot(
        JSON.parse(
          JSON.stringify({
            ...llmParamsWithTools,
            schema,
            schemaSanitizePromptInjection,
          }),
        ),
      );
      const hash = hashOf(requestSnapshot).toString();
      const queueName = inputs.key("queue").withTx(tx).get() as unknown as
        | string
        | undefined;
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();
      const currentError = errorWithLog.get();
      const toolsRequestSummary = summarizeGenerateObjectRequest({
        hash,
        path: "tools",
        model: llmParamsWithTools.model,
        hasTools: true,
        toolNames: Object.keys(toolCatalog.llmTools),
        messageCount: requestMessages.length,
        contextKeys: context ? Object.keys(context) : [],
        queueName,
      });

      // Return if the same request is being made again
      // Also return if there's an error for this request (don't retry automatically)
      if (
        (currentResult !== undefined || currentError !== undefined) &&
        hash === currentRequestHash
      ) {
        logGenerateObject("skip-cached", toolsRequestSummary);
        return;
      }

      if (hash === previousCallHash) {
        logGenerateObject("skip-inflight", toolsRequestSummary);
        return;
      }

      markRequestHashPendingCommit(
        tx,
        hash,
        () => previousCallHash,
        (next) => {
          previousCallHash = next;
        },
      );

      if (hash !== currentRequestHash) {
        currentRun++;
      }
      const thisRun = currentRun;

      resultWithLog.set(undefined);
      messagesWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      messagesWithLog.set(JSON.parse(JSON.stringify(requestMessages)) as any);
      pendingWithLog.set(true);

      const { callback: updatePartial, cleanup: cleanupPartial } =
        createUpdatePartialCallback(
          resultCell,
          runtime,
          queueName ? () => thisRun : () => currentRun,
          thisRun,
        );

      // When queued, disable run cancellation — the queue manages lifecycle.
      const isRunCancelled = queueName
        ? () => false
        : () => thisRun !== currentRun;

      logGenerateObject("enqueue", toolsRequestSummary);

      enqueuePostCommitLLMWork(
        tx,
        "generateObject",
        `generateObject:${hash}`,
        "generateObject-start",
        requestSnapshot,
        () => {
          logGenerateObject("post-commit-start", toolsRequestSummary);
          const resultPromise = (async () => {
            try {
              await inputs.pull();
              const liveContext = inputs.key("context").get() as
                | Record<string, unknown>
                | undefined;
              await pullContextCells(liveContext);
              const liveContextDocs = liveContext
                ? llmToolExecutionHelpers
                  .buildAvailableCellsDocumentationWithObservation(
                    runtime,
                    parentCell.space,
                    liveContext as Record<string, Cell<any>>,
                    runtime.getCell(
                      parentCell.space,
                      { generateObject: { pinnedCells: [] } },
                      pinnedCellsSchema,
                    ),
                    observationMaxConfidentiality,
                  )
                : {
                  docs: "",
                  observedConfidentiality: [],
                };
              const liveSystem =
                ((system ?? "") + liveContextDocs.docs).trim() ||
                "You are a helpful assistant.";
              const livePromptObservedConfidentiality =
                collectGenerateObjectPromptConfidentiality(inputs);
              const liveInitialObservedConfidentiality = uniqueCfcAtoms([
                ...livePromptObservedConfidentiality,
                ...liveContextDocs.observedConfidentiality,
              ]);

              // Execute with tools - capture presentResult when called
              let finalResult: T | undefined;
              let finalMessages: readonly BuiltInLLMMessage[] = requestMessages;
              let finalObservedConfidentiality: readonly unknown[] =
                liveInitialObservedConfidentiality;

              // Custom execution loop for generateObject with presentResult extraction
              const executeRecursive = async (
                currentMessages: readonly BuiltInLLMMessage[],
                observedConfidentiality: readonly unknown[],
              ): Promise<void> => {
                if (isRunCancelled()) return;

                const requestParams: LLMRequest = {
                  ...llmParamsWithTools,
                  system: liveSystem,
                  messages: currentMessages,
                };

                const mappedLlmHost = runtime.mappedHostFor(
                  parentCell.space,
                );
                const llmResult = await client.sendRequest(
                  requestParams,
                  updatePartial,
                  undefined,
                  mappedLlmHost
                    ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
                    : undefined,
                );

                if (isRunCancelled()) return;

                const toolCallParts = llmToolExecutionHelpers
                  .extractToolCallParts(llmResult.content);
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
                      undefined,
                      observedConfidentiality,
                      observationMaxConfidentiality,
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
                  finalMessages = updatedMessages;

                  const nextObservedConfidentiality = uniqueCfcAtoms([
                    ...observedConfidentiality,
                    ...toolResults.flatMap((result) =>
                      result.observedConfidentiality ?? []
                    ),
                  ]);
                  if (presentResultPart) {
                    finalObservedConfidentiality = nextObservedConfidentiality;
                  }

                  // Continue if presentResult wasn't called yet
                  if (!presentResultPart) {
                    await executeRecursive(
                      updatedMessages,
                      nextObservedConfidentiality,
                    );
                  }
                } else {
                  throw new Error(
                    "LLM did not call presentResult tool with structured data",
                  );
                }
              };

              const doWork = async () => {
                logGenerateObject("tools-loop-start", toolsRequestSummary);
                await executeRecursive(
                  requestMessages,
                  liveInitialObservedConfidentiality,
                );

                if (finalResult === undefined) {
                  throw new Error("presentResult was never called");
                }
                validateResultForSchemaSanitization(finalResult);

                return {
                  object: finalResult,
                  messages: finalMessages,
                  resultSchema: resultSchemaForObserved(
                    finalObservedConfidentiality,
                  ),
                };
              };

              const objectResponse = queueName
                ? await runtime.getOrCreateQueue(queueName).enqueue(doWork)
                : await doWork();

              logGenerateObject("tools-loop-complete", {
                ...toolsRequestSummary,
                objectKeys: Object.keys(objectResponse.object ?? {}),
              });

              if (isRunCancelled()) {
                logGenerateObject(
                  "write-skipped-cancelled",
                  toolsRequestSummary,
                );
                return;
              }

              await runtime.idle();

              await runtime.editWithRetry((tx) => {
                // The InjectionSafe annotations on resultSchema are minted by
                // the trusted sanitizer; attribute this write to the builtin so
                // the persist-time evidence gate trusts them (audit S4).
                tx.setCfcImplementationIdentity({
                  kind: "builtin",
                  builtinId: "generateObject",
                });
                resultCell.key("pending").withTx(tx).set(false);
                const resultTarget = objectResponse.resultSchema === undefined
                  ? resultCell.key("result")
                  : resultCell.key("result").asSchema(
                    objectResponse.resultSchema,
                  );
                resultTarget.withTx(tx).set(objectResponse.object);
                resultCell.key("messages").withTx(tx).set(
                  JSON.parse(JSON.stringify(objectResponse.messages)) as any,
                );
                resultCell.key("error").withTx(tx).set(undefined);
                resultCell.key("requestHash").withTx(tx).set(hash);
              });
              logGenerateObject("write-complete", toolsRequestSummary);
            } finally {
              cleanupPartial();
            }
          })();

          resultPromise.catch((e) => {
            logGenerateObject("error", {
              ...toolsRequestSummary,
              error: e instanceof Error ? e.message : String(e),
            });
            return handleLLMError(
              e,
              runtime,
              resultCell.key("pending"),
              resultCell.key("result"),
              resultCell.key("error"),
              resultCell.key("partial"),
              resultCell.key("requestHash"),
              hash,
              queueName ? () => thisRun : () => currentRun,
              thisRun,
              () => {
                previousCallHash = undefined;
              },
            );
          });
        },
      );
    } else {
      // Use direct generateObject path (no tools)
      const generateObjectParams: LLMGenerateObjectRequest = {
        messages: requestMessages,
        maxTokens: maxTokens ?? 8192,
        schema: llmToolExecutionHelpers.prepareSchemaForLLM(
          toDeepFrozenSchema(schema),
        ) as Record<string, unknown>,
        model: model ?? DEFAULT_GENERATE_OBJECT_MODELS,
        metadata: {
          ...readyMetadata,
          context: "piece",
        },
        cache: cache ?? true,
        ...(effectiveNativeModelToolIds
          ? { nativeModelToolIds: effectiveNativeModelToolIds }
          : {}),
      };

      // Always set system prompt with context documentation
      generateObjectParams.system =
        ((system ?? "") + contextDocs.docs).trim() ||
        "You are a helpful assistant.";

      const requestSnapshot = createFrozenRequestSnapshot({
        ...generateObjectParams,
        schemaSanitizePromptInjection,
      });
      const hash = hashOf(requestSnapshot).toString();
      const queueName = inputs.key("queue").withTx(tx).get() as unknown as
        | string
        | undefined;
      const currentRequestHash = requestHashWithLog.get();
      const currentResult = resultWithLog.get();
      const currentError = errorWithLog.get();
      const directRequestSummary = summarizeGenerateObjectRequest({
        hash,
        path: "direct",
        model: generateObjectParams.model,
        hasTools: false,
        messageCount: requestMessages.length,
        contextKeys: context ? Object.keys(context) : [],
        queueName,
      });

      // Return if the same request is being made again
      // Also return if there's an error for this request (don't retry automatically)
      if (
        (currentResult !== undefined || currentError !== undefined) &&
        hash === currentRequestHash
      ) {
        logGenerateObject("skip-cached", directRequestSummary);
        return;
      }

      // Also skip if this is the same request in the current transaction
      if (hash === previousCallHash) {
        logGenerateObject("skip-inflight", directRequestSummary);
        return;
      }

      markRequestHashPendingCommit(
        tx,
        hash,
        () => previousCallHash,
        (next) => {
          previousCallHash = next;
        },
      );

      // Only increment currentRun if this is a NEW request (different hash)
      // This prevents abandoning in-flight requests when the same params are re-evaluated
      if (hash !== currentRequestHash) {
        currentRun++;
      }
      const thisRun = currentRun;

      resultWithLog.set(undefined);
      messagesWithLog.set(undefined);
      errorWithLog.set(undefined);
      partialWithLog.set(undefined);
      messagesWithLog.set(JSON.parse(JSON.stringify(requestMessages)) as any);
      pendingWithLog.set(true);

      const isRunCancelled = queueName
        ? () => false
        : () => thisRun !== currentRun;

      logGenerateObject("enqueue", directRequestSummary);

      enqueuePostCommitLLMWork(
        tx,
        "generateObject",
        `generateObject:${hash}`,
        "generateObject-start",
        requestSnapshot,
        () => {
          logGenerateObject("post-commit-start", directRequestSummary);
          const doWork = async () => {
            logGenerateObject("direct-work-start", directRequestSummary);
            await inputs.pull();
            const liveContext = inputs.key("context").get() as
              | Record<string, unknown>
              | undefined;
            await pullContextCells(liveContext);
            const liveContextDocs = liveContext
              ? llmToolExecutionHelpers
                .buildAvailableCellsDocumentationWithObservation(
                  runtime,
                  parentCell.space,
                  liveContext as Record<string, Cell<any>>,
                  runtime.getCell(
                    parentCell.space,
                    { generateObject: { pinnedCells: [] } },
                    pinnedCellsSchema,
                  ),
                  observationMaxConfidentiality,
                )
              : {
                docs: "",
                observedConfidentiality: [],
              };
            logGenerateObject("client-generateObject-start", {
              ...directRequestSummary,
              observedConfidentialityCount: uniqueCfcAtoms([
                ...collectGenerateObjectPromptConfidentiality(inputs),
                ...liveContextDocs.observedConfidentiality,
              ]).length,
            });
            const mappedLlmHost = runtime.mappedHostFor(
              parentCell.space,
            );
            const response = await client.generateObject(
              {
                ...generateObjectParams,
                system: ((system ?? "") + liveContextDocs.docs).trim() ||
                  "You are a helpful assistant.",
              },
              undefined,
              mappedLlmHost
                ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
                : undefined,
            ) as {
              object: T;
            };
            logGenerateObject("client-generateObject-complete", {
              ...directRequestSummary,
              objectKeys: Object.keys(response.object ?? {}),
            });
            validateResultForSchemaSanitization(response.object);
            const livePromptObservedConfidentiality =
              collectGenerateObjectPromptConfidentiality(inputs);
            return {
              ...response,
              resultSchema: resultSchemaForObserved(
                uniqueCfcAtoms([
                  ...livePromptObservedConfidentiality,
                  ...liveContextDocs.observedConfidentiality,
                ]),
              ),
            };
          };

          const resultPromise = queueName
            ? runtime.getOrCreateQueue(queueName).enqueue(doWork)
            : doWork();

          resultPromise
            .then(async (response) => {
              if (isRunCancelled()) {
                logGenerateObject(
                  "write-skipped-cancelled",
                  directRequestSummary,
                );
                return;
              }

              await runtime.idle();

              await runtime.editWithRetry((tx) => {
                // The InjectionSafe annotations on resultSchema are minted by
                // the trusted sanitizer; attribute this write to the builtin so
                // the persist-time evidence gate trusts them (audit S4).
                tx.setCfcImplementationIdentity({
                  kind: "builtin",
                  builtinId: "generateObject",
                });
                const assistantMessage: BuiltInLLMMessage = {
                  role: "assistant",
                  content: JSON.stringify(response.object, null, 2),
                };
                resultCell.key("pending").withTx(tx).set(false);
                const resultTarget = response.resultSchema === undefined
                  ? resultCell.key("result")
                  : resultCell.key("result").asSchema(response.resultSchema);
                resultTarget.withTx(tx).set(response.object);
                resultCell.key("messages").withTx(tx).set([
                  ...JSON.parse(JSON.stringify(requestMessages)),
                  JSON.parse(JSON.stringify(assistantMessage)),
                ] as any);
                resultCell.key("error").withTx(tx).set(undefined);
                resultCell.key("requestHash").withTx(tx).set(hash);
              });
              logGenerateObject("write-complete", directRequestSummary);
            })
            .catch((e) => {
              logGenerateObject("error", {
                ...directRequestSummary,
                error: e instanceof Error ? e.message : String(e),
              });
              return handleLLMError(
                e,
                runtime,
                resultCell.key("pending"),
                resultCell.key("result"),
                resultCell.key("error"),
                resultCell.key("partial"),
                resultCell.key("requestHash"),
                hash,
                queueName ? () => thisRun : () => currentRun,
                thisRun,
                () => {
                  previousCallHash = undefined;
                },
              );
            });
        },
      );
    }
  };
}

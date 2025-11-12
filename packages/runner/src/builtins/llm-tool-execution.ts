/**
 * Shared tool execution logic for LLM built-ins.
 *
 * This module provides reusable tool calling functionality that can be used by
 * llmDialog, generateText, and generateObject. It handles:
 * - Tool catalog construction
 * - Tool call resolution (legacy tools, charm-based tools, patterns, handlers)
 * - Tool execution with runtime context
 * - Message formatting for tool calls and results
 */

import { LLMToolCall } from "@commontools/llm";
import type {
  BuiltInLLMMessage,
  BuiltInLLMToolCallPart,
  JSONSchema,
} from "commontools";
import type { Cell, MemorySpace } from "../cell.ts";
import { isStream } from "../cell.ts";
import { NAME, type Recipe, TYPE } from "../builder/types.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { getLogger } from "@commontools/utils/logger";
import {
  debugTransactionWrites,
  formatTransactionSummary,
} from "../storage/transaction-summary.ts";

const logger = getLogger("llm-tool-execution", {
  enabled: true,
  level: "info",
});

// --------------------
// Helper types + utils
// --------------------

type ToolKind = "handler" | "cell" | "pattern";

/**
 * Slugifies a string to match the pattern ^[a-zA-Z0-9_-]{1,128}$
 * Replaces spaces and invalid characters with underscores, truncates to 128 chars
 */
export function slugify(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 128);
}

/**
 * Remove the injected `result` field from a JSON schema so tools don't
 * advertise it as an input parameter.
 */
function stripInjectedResult(
  schema: unknown,
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") return schema;

  const copy: Record<string, unknown> = { ...obj };
  const props = copy.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    const { result: _, ...rest } = props as Record<string, unknown>;
    copy.properties = rest;
  }
  const req = copy.required as unknown[] | undefined;
  if (Array.isArray(req)) {
    copy.required = req.filter((k) => k !== "result");
  }
  return copy;
}

function normalizeInputSchema(schemaLike: unknown): JSONSchema {
  let inputSchema: any = schemaLike;
  if (typeof inputSchema === "boolean") {
    inputSchema = {
      type: "object",
      properties: {},
      additionalProperties: inputSchema,
    };
  }
  if (!inputSchema || typeof inputSchema !== "object") {
    inputSchema = { type: "object" };
  }
  return stripInjectedResult(inputSchema) as JSONSchema;
}

/**
 * Resolve a charm's result schema similarly to CharmManager.#getResultSchema:
 * - Prefer a non-empty recipe.resultSchema if recipe is loaded
 * - Otherwise derive a simple object schema from the current value
 */
async function getCharmResultSchemaAsync(
  runtime: IRuntime,
  charm: Cell<any>,
): Promise<JSONSchema | undefined> {
  try {
    const source = charm.getSourceCell();
    const recipeId = source?.get()?.[TYPE];
    if (recipeId) {
      await runtime.recipeManager.loadRecipe(recipeId, charm.space);
    }
    return (
      getLoadedRecipeResultSchema(runtime, charm) ??
        buildMinimalSchemaFromValue(charm)
    );
  } catch (_e) {
    return buildMinimalSchemaFromValue(charm);
  }
}

function stringifySchemaGuarded(schema: JSONSchema | undefined): string {
  try {
    const s = JSON.stringify(schema ?? {});
    return s.length > 4000 ? s.slice(0, 4000) + "…" : s;
  } catch {
    return "{}";
  }
}

function getLoadedRecipeResultSchema(
  runtime: IRuntime | undefined,
  charm: Cell<any>,
): JSONSchema | undefined {
  try {
    const source = charm.getSourceCell();
    const recipeId = source?.get()?.[TYPE];
    const recipe = recipeId
      ? runtime?.recipeManager.recipeById(recipeId)
      : undefined;
    if (
      recipe && typeof recipe.resultSchema === "object" &&
      recipe.resultSchema && Object.keys(recipe.resultSchema).length > 0
    ) {
      return recipe.resultSchema;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function buildMinimalSchemaFromValue(charm: Cell<any>): JSONSchema | undefined {
  try {
    const resultValue = charm.asSchema().get();
    if (resultValue && typeof resultValue === "object") {
      const keys = Object.keys(resultValue).filter((k) => !k.startsWith("$"));
      if (keys.length > 0) {
        return {
          type: "object",
          properties: Object.fromEntries(keys.map((k) => [k, true])),
        } as JSONSchema;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

type LegacyToolEntry = {
  name: string;
  tool: any;
  cell: Cell<any>;
};

type CharmToolEntry = {
  name: string;
  charm: Cell<any>;
  charmName: string;
};

type AggregatedCharmToolMeta = {
  kind: "read" | "run";
  charm: Cell<any>;
};

export type ToolCatalog = {
  llmTools: Record<string, { description: string; inputSchema: JSONSchema }>;
  legacyToolCells: Map<string, Cell<any>>;
  aggregatedTools: Map<string, AggregatedCharmToolMeta>;
};

function collectToolEntries(
  toolsCell: Cell<any>,
): { legacy: LegacyToolEntry[]; charms: CharmToolEntry[] } {
  const tools = toolsCell.get() ?? {};
  const legacy: LegacyToolEntry[] = [];
  const charms: CharmToolEntry[] = [];

  for (const [name, tool] of Object.entries(tools)) {
    if (tool?.charm?.get?.()) {
      const charm: Cell<any> = tool.charm;
      const charmValue = charm.get();
      const charmName = String(charmValue?.[NAME] ?? name);
      charms.push({ name, charm, charmName });
      continue;
    }

    legacy.push({
      name,
      tool,
      cell: toolsCell.key(name),
    });
  }

  return { legacy, charms };
}

export function createCharmToolDefinitions(
  charmName: string,
  schemaString: string,
): {
  read: { name: string; description: string; inputSchema: JSONSchema };
  run: { name: string; description: string; inputSchema: JSONSchema };
} {
  const slug = slugify(charmName);
  const readName = `${slug}_read`;
  const runName = `${slug}_run`;

  const readDescription =
    `Read values from charm "${charmName}" using path: string[]. ` +
    `Construct paths by walking the charm schema (single key -> ["key"]). ` +
    `Schema: ${schemaString}`;

  const runDescription =
    `Run handlers on charm "${charmName}" using path: string[] ` +
    `to a handler stream and args: object. You may pass args nested ` +
    `under input.args or as top-level fields (path removed). ` +
    `Schema: ${schemaString}`;

  const readInputSchema: JSONSchema = {
    type: "object",
    properties: {
      path: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  };

  const runInputSchema: JSONSchema = {
    type: "object",
    properties: {
      path: { type: "array", items: { type: "string" }, minItems: 1 },
      args: { type: "object" },
    },
    required: ["path"],
    additionalProperties: false,
  };

  return {
    read: {
      name: readName,
      description: readDescription,
      inputSchema: readInputSchema,
    },
    run: {
      name: runName,
      description: runDescription,
      inputSchema: runInputSchema,
    },
  };
}

export async function buildToolCatalog(
  runtime: IRuntime,
  toolsCell: Cell<any>,
): Promise<ToolCatalog> {
  const { legacy, charms } = collectToolEntries(toolsCell);

  const llmTools: ToolCatalog["llmTools"] = {};
  const legacyToolCells = new Map<string, Cell<any>>();
  const aggregatedTools = new Map<string, AggregatedCharmToolMeta>();

  for (const entry of legacy) {
    const toolValue: any = entry.tool ?? {};
    const pattern = toolValue?.pattern?.get?.() ?? toolValue?.pattern;
    const handler = toolValue?.handler;
    let inputSchema = pattern?.argumentSchema ?? handler?.schema ??
      toolValue?.inputSchema;
    if (inputSchema === undefined) continue;
    inputSchema = normalizeInputSchema(inputSchema);
    const description: string = toolValue.description ??
      (inputSchema as any)?.description ?? "";
    llmTools[entry.name] = { description, inputSchema };
    legacyToolCells.set(entry.name, entry.cell);
  }

  for (const entry of charms) {
    const schema = await getCharmResultSchemaAsync(runtime, entry.charm) ?? {};
    const schemaString = stringifySchemaGuarded(schema as JSONSchema);
    const charmTools = createCharmToolDefinitions(
      entry.charmName,
      schemaString,
    );

    llmTools[charmTools.read.name] = {
      description: charmTools.read.description,
      inputSchema: charmTools.read.inputSchema,
    };
    llmTools[charmTools.run.name] = {
      description: charmTools.run.description,
      inputSchema: charmTools.run.inputSchema,
    };

    aggregatedTools.set(charmTools.read.name, {
      kind: "read",
      charm: entry.charm,
    });
    aggregatedTools.set(charmTools.run.name, {
      kind: "run",
      charm: entry.charm,
    });
  }

  return { llmTools, legacyToolCells, aggregatedTools };
}

export function normalizeCharmPathSegments(input: unknown): string[] {
  const rawPath = (input && typeof input === "object")
    ? (input as any).path
    : undefined;
  const parts = Array.isArray(rawPath)
    ? rawPath.map((segment) => String(segment))
    : [];
  if (parts.length === 0) {
    throw new Error("path must be an array of strings");
  }
  return parts.filter((segment) =>
    segment !== undefined && segment !== null && `${segment}`.length > 0
  ).map((segment) => segment.toString());
}

export function extractRunArguments(input: unknown): Record<string, any> {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.args && typeof obj.args === "object") {
      return obj.args as Record<string, any>;
    }
    const { path: _path, ...rest } = obj;
    return rest as Record<string, any>;
  }
  return {};
}

function resolveToolCall(
  runtime: IRuntime,
  toolCallPart: BuiltInLLMToolCallPart,
  catalog: ToolCatalog,
): {
  call: LLMToolCall;
  toolDef?: Cell<any>;
  charmMeta?: {
    handler?: any;
    cell?: Cell<any>;
    charm: Cell<any>;
    extraParams?: Record<string, unknown>;
    pattern?: Readonly<Recipe>;
  };
} {
  const name = toolCallPart.toolName;
  const id = toolCallPart.toolCallId;
  const legacyTool = catalog.legacyToolCells.get(name);
  if (legacyTool) {
    return {
      toolDef: legacyTool,
      call: { id, name, input: toolCallPart.input },
    };
  }

  const aggregated = catalog.aggregatedTools.get(name);
  if (!aggregated) {
    throw new Error("Tool has neither pattern nor handler");
  }

  const segments = normalizeCharmPathSegments(toolCallPart.input);
  const baseLink = aggregated.charm.getAsNormalizedFullLink();
  const link = {
    ...baseLink,
    path: [
      ...baseLink.path,
      ...segments.map((segment) => segment.toString()),
    ],
  };

  if (aggregated.kind === "read") {
    const maybeRef: Cell<any> = runtime.getCellFromLink(link);
    if (isStream(maybeRef)) {
      throw new Error("path resolves to a handler stream; use <slug>_run");
    }
    return {
      charmMeta: { cell: aggregated.charm, charm: aggregated.charm },
      call: { id, name, input: toolCallPart.input },
    };
  }

  const ref: Cell<any> = runtime.getCellFromLink(link);
  if (isStream(ref)) {
    return {
      charmMeta: { handler: ref as any, charm: aggregated.charm },
      call: {
        id,
        name,
        input: extractRunArguments(toolCallPart.input),
      },
    };
  }

  const pattern = (ref as Cell<any>).key("pattern")
    .getRaw() as unknown as Readonly<Recipe> | undefined;
  if (pattern) {
    return {
      charmMeta: {
        pattern,
        extraParams: (ref as Cell<any>).key("extraParams").get() ?? {},
        charm: aggregated.charm,
      },
      call: {
        id,
        name,
        input: extractRunArguments(toolCallPart.input),
      },
    };
  }

  throw new Error("path does not resolve to a handler stream");
}

export function extractToolCallParts(
  content: BuiltInLLMMessage["content"],
): BuiltInLLMToolCallPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is BuiltInLLMToolCallPart =>
    (part as BuiltInLLMToolCallPart).type === "tool-call"
  );
}

/**
 * Validates whether message content is non-empty and valid for the Anthropic API.
 * Returns true if the content contains at least one non-empty text block or tool call.
 */
export function hasValidContent(
  content: BuiltInLLMMessage["content"],
): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((part) => {
      if (part.type === "tool-call" || part.type === "tool-result") {
        return true;
      }
      if (part.type === "text") {
        return (part as any).text?.trim().length > 0;
      }
      return false;
    });
  }

  return false;
}

export function buildAssistantMessage(
  content: BuiltInLLMMessage["content"],
  toolCallParts: BuiltInLLMToolCallPart[],
): BuiltInLLMMessage {
  const assistantContentParts: Array<any> = [];

  if (typeof content === "string" && content) {
    assistantContentParts.push({
      type: "text",
      text: content,
    });
  } else if (Array.isArray(content)) {
    assistantContentParts.push(
      ...content.filter((part) => part.type === "text"),
    );
  }

  assistantContentParts.push(...toolCallParts);

  return {
    role: "assistant",
    content: assistantContentParts,
  };
}

export type ToolCallExecutionResult = {
  id: string;
  toolName: string;
  result?: any;
  error?: string;
};

/**
 * Ensures that a source charm is running using the charm context,
 * then calls runSynced to ensure it's actively running.
 *
 * @param runtime - The runtime instance
 * @param meta - The charm context containing handler and owning charm
 * @returns Promise that resolves when the charm is running
 */
async function ensureSourceCharmRunning(
  runtime: IRuntime,
  meta: { handler?: any; charm: Cell<any> },
): Promise<void> {
  const charm = meta.charm;
  const result = charm.asSchema({});
  const process = charm.getSourceCell();
  const recipeId = process?.get()?.[TYPE];
  if (recipeId) {
    const recipe = await runtime.recipeManager.loadRecipe(
      recipeId,
      charm.space,
    );
    await runtime.runSynced(result, recipe);
    // Ensure scheduler has registered handlers before we enqueue events
    await runtime.idle();
  }
}

/**
 * Executes a tool call by invoking its handler function and returning the
 * result. Creates a new transaction, sends the tool call arguments to the
 * handler, and waits for the result to be available before returning it.
 *
 * @param runtime - The runtime instance for creating transactions and cells
 * @param space - The memory space context for the tool execution
 * @param toolDef - Cell containing the tool definition with handler
 * @param toolCall - The LLM tool call containing id, name, and arguments
 * @param charmMeta - Optional handler for charm-extracted tools
 * @returns Promise that resolves to the tool execution result
 */
async function invokeToolCall(
  runtime: IRuntime,
  space: MemorySpace,
  toolDef: Cell<any> | undefined,
  toolCall: LLMToolCall,
  charmMeta?: {
    handler?: any;
    cell?: Cell<any>;
    charm: Cell<any>;
    extraParams?: Record<string, unknown>;
    pattern?: Readonly<Recipe>;
  },
) {
  const pattern = charmMeta?.pattern ??
    toolDef?.key("pattern").getRaw() as unknown as
      | Readonly<Recipe>
      | undefined;
  const extraParams = charmMeta?.extraParams ??
    toolDef?.key("extraParams").get() ??
    {};
  const handler = charmMeta?.handler ?? toolDef?.key("handler");
  const result = runtime.getCell<any>(space, toolCall.id);

  // Cell tools (aggregated _read): materialize via getAsQueryResult(path)
  if (charmMeta?.cell) {
    const input = toolCall.input as any;
    const pathParts = Array.isArray(input?.path)
      ? input.path.map((s: any) => String(s))
      : [];
    const realized = charmMeta.cell.getAsQueryResult(pathParts);
    // Ensure we return plain JSON by stringifying and parsing
    const value = JSON.parse(JSON.stringify(realized));
    return { type: "json", value };
  }

  // ensure the charm this handler originates from is actually running
  if (handler && !pattern && charmMeta) {
    await ensureSourceCharmRunning(runtime, charmMeta);
  }

  const { resolve, promise } = Promise.withResolvers<any>();

  runtime.editWithRetry((tx) => {
    if (pattern) {
      runtime.run(tx, pattern, { ...toolCall.input, ...extraParams }, result);
    } else if (handler) {
      handler.withTx(tx).send({
        ...toolCall.input,
        result, // doesn't HAVE to be used, but can be
      }, (completedTx: IExtendedStorageTransaction) => {
        logger.info("Handler tx:", debugTransactionWrites(completedTx));

        const summary = formatTransactionSummary(completedTx, space);
        const value = result.withTx(completedTx).get();

        resolve({ value, summary });
      });
    } else {
      throw new Error("Tool has neither pattern nor handler");
    }
  });

  // wait until we know we have the result of the tool call
  // not just that the transaction has been comitted
  const cancel = result.sink((r) => {
    r !== undefined && resolve(r);
  });
  let resultValue = await promise;
  cancel();

  if (pattern) {
    // stop it now that we have the result
    runtime.runner.stop(result);
  } else {
    await runtime.idle(); // maybe pointless
  }

  // Prevent links being returned
  resultValue = JSON.parse(JSON.stringify(resultValue ?? "OK"));

  return { type: "json", value: resultValue };
}

export async function executeToolCalls(
  runtime: IRuntime,
  space: MemorySpace,
  toolCatalog: ToolCatalog,
  toolCallParts: BuiltInLLMToolCallPart[],
): Promise<ToolCallExecutionResult[]> {
  const results: ToolCallExecutionResult[] = [];
  for (const part of toolCallParts) {
    try {
      const resolved = resolveToolCall(runtime, part, toolCatalog);
      const resultValue = await invokeToolCall(
        runtime,
        space,
        resolved.toolDef,
        resolved.call,
        resolved.charmMeta,
      );
      results.push({
        id: part.toolCallId,
        toolName: part.toolName,
        result: resultValue,
      });
    } catch (error) {
      console.error(`Tool ${part.toolName} failed:`, error);
      results.push({
        id: part.toolCallId,
        toolName: part.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function createToolResultMessages(
  results: ToolCallExecutionResult[],
): BuiltInLLMMessage[] {
  return results.map((toolResult) => {
    // Ensure output is never undefined/null - Anthropic API requires valid tool_result
    // for every tool_use, even if the tool returns nothing
    let output: any;
    if (toolResult.error) {
      output = { type: "error-text", value: toolResult.error };
    } else if (toolResult.result === undefined || toolResult.result === null) {
      // Tool returned nothing - use explicit null value
      output = { type: "json", value: null };
    } else {
      output = toolResult.result;
    }

    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: toolResult.id,
        toolName: toolResult.toolName || "unknown",
        output,
      }],
    };
  });
}

/**
 * Processes an LLM response that may contain tool calls, executing them and
 * continuing the conversation until a final assistant message is received.
 *
 * This is the core tool execution loop that supports both:
 * - llmDialog: Runs once per addMessage, then waits for next event
 * - generateText/Object: Runs to completion (until no more tool calls)
 *
 * @param params - Configuration for the tool execution loop
 * @returns The final messages array with all tool calls executed
 */
export async function processToolCalls(params: {
  runtime: IRuntime;
  space: MemorySpace;
  toolCatalog: ToolCatalog;
  llmContent: BuiltInLLMMessage["content"];
  continueConversation: (
    messages: BuiltInLLMMessage[],
  ) => Promise<BuiltInLLMMessage>;
  shouldContinue: () => boolean;
  maxIterations?: number;
}): Promise<{
  finalContent: BuiltInLLMMessage["content"];
  allMessages: BuiltInLLMMessage[];
}> {
  const {
    runtime,
    space,
    toolCatalog,
    llmContent,
    continueConversation,
    shouldContinue,
    maxIterations = 50,
  } = params;

  const allMessages: BuiltInLLMMessage[] = [];
  let currentContent = llmContent;
  let iterations = 0;

  while (iterations < maxIterations && shouldContinue()) {
    iterations++;

    const toolCallParts = extractToolCallParts(currentContent);

    // No tool calls - we're done
    if (toolCallParts.length === 0) {
      return { finalContent: currentContent, allMessages };
    }

    // Build assistant message with tool calls
    const assistantMessage = buildAssistantMessage(
      currentContent,
      toolCallParts,
    );
    allMessages.push(assistantMessage);

    // Execute all tool calls
    const toolResults = await executeToolCalls(
      runtime,
      space,
      toolCatalog,
      toolCallParts,
    );

    // Validate we have results for all tool calls
    const toolCallIds = new Set(toolCallParts.map((p) => p.toolCallId));
    const resultIds = new Set(toolResults.map((r) => r.id));
    const mismatch = toolResults.length !== toolCallParts.length ||
      !toolCallParts.every((p) => resultIds.has(p.toolCallId));

    if (mismatch) {
      logger.error(
        `Tool execution mismatch: ${toolCallParts.length} calls [${
          Array.from(toolCallIds)
        }] but ${toolResults.length} results [${Array.from(resultIds)}]`,
      );
      throw new Error("Some tool calls failed to execute");
    }

    // Create tool result messages
    const toolResultMessages = createToolResultMessages(toolResults);
    allMessages.push(...toolResultMessages);

    // Continue the conversation with tool results
    const nextResponse = await continueConversation(toolResultMessages);
    currentContent = nextResponse.content;

    // Validate the response has valid content
    if (!hasValidContent(currentContent)) {
      logger.warn("LLM returned invalid/empty content after tool execution");
      throw new Error("LLM returned invalid/empty content");
    }
  }

  if (iterations >= maxIterations) {
    logger.warn(`Tool execution loop hit max iterations (${maxIterations})`);
  }

  return { finalContent: currentContent, allMessages };
}

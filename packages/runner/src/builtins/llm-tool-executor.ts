import {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from "@commontools/llm";
import type {
  BuiltInLLMMessage,
  BuiltInLLMTextPart,
  BuiltInLLMToolCallPart,
  JSONSchema,
  Schema,
} from "commontools";
import { getLogger } from "@commontools/utils/logger";
import type { Cell, MemorySpace } from "../cell.ts";
import { isStream } from "../cell.ts";
import { ID, NAME, type Recipe, TYPE } from "../builder/types.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  debugTransactionWrites,
  formatTransactionSummary,
} from "../storage/transaction-summary.ts";

const logger = getLogger("llm-tool-executor", {
  enabled: true,
  level: "info",
});

// Max iterations to prevent infinite loops
const MAX_TOOL_CALL_ITERATIONS = 10;

// Re-export types that are needed by consumers
export type { BuiltInLLMMessage, BuiltInLLMToolCallPart, JSONSchema };

// Tool catalog types (from llm-dialog.ts)
const LLMToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
    handler: {
      asStream: true,
    },
    pattern: {
      type: "object",
      properties: {
        argumentSchema: { type: "object" },
        resultSchema: { type: "object" },
        nodes: { type: "array", items: { type: "object" } },
        program: { type: "object" },
        initial: { type: "object" },
      },
      required: ["argumentSchema", "resultSchema", "nodes"],
      asCell: true,
    },
    extraParams: { type: "object" },
    charm: {
      asCell: true,
    },
  },
  required: [],
} as const satisfies JSONSchema;

type LegacyToolEntry = {
  name: string;
  tool: any;
  cell: Cell<Schema<typeof LLMToolSchema>>;
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
  legacyToolCells: Map<string, Cell<Schema<typeof LLMToolSchema>>>;
  aggregatedTools: Map<string, AggregatedCharmToolMeta>;
};

export type ToolCallExecutionResult = {
  id: string;
  toolName: string;
  result?: any;
  error?: string;
};

export type ToolCallLog = {
  iteration: number;
  toolCalls: Array<{
    name: string;
    input: any;
    result?: any;
    error?: string;
  }>;
  llmResponse: string;
};

export type ExecuteWithToolCallsResult = {
  finalResponse: LLMResponse;
  toolCallLogs: ToolCallLog[];
  iterationCount: number;
};

/**
 * Slugifies a string to match the pattern ^[a-zA-Z0-9_-]{1,128}$
 */
function slugify(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 128);
}

/**
 * Remove the injected `result` field from a JSON schema
 */
function stripInjectedResult(schema: unknown): unknown {
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
 * Resolve a charm's result schema
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
      cell: toolsCell.key(name) as unknown as Cell<
        Schema<typeof LLMToolSchema>
      >,
    });
  }

  return { legacy, charms };
}

function createCharmToolDefinitions(
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

/**
 * Build a tool catalog from a tools cell
 */
export async function buildToolCatalog(
  runtime: IRuntime,
  toolsCell: Cell<any>,
): Promise<ToolCatalog> {
  const { legacy, charms } = collectToolEntries(toolsCell);

  const llmTools: ToolCatalog["llmTools"] = {};
  const legacyToolCells = new Map<string, Cell<Schema<typeof LLMToolSchema>>>();
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

function normalizeCharmPathSegments(input: unknown): string[] {
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

function extractRunArguments(input: unknown): Record<string, any> {
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

export function resolveToolCall(
  runtime: IRuntime,
  toolCallPart: BuiltInLLMToolCallPart,
  catalog: ToolCatalog,
): {
  call: LLMToolCall;
  toolDef?: Cell<Schema<typeof LLMToolSchema>>;
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

export function buildAssistantMessage(
  content: BuiltInLLMMessage["content"],
  toolCallParts: BuiltInLLMToolCallPart[],
): BuiltInLLMMessage {
  const assistantContentParts: Array<
    BuiltInLLMTextPart | BuiltInLLMToolCallPart
  > = [];

  if (typeof content === "string" && content) {
    assistantContentParts.push({
      type: "text",
      text: content,
    });
  } else if (Array.isArray(content)) {
    assistantContentParts.push(
      ...content.filter((part) => part.type === "text") as BuiltInLLMTextPart[],
    );
  }

  assistantContentParts.push(...toolCallParts);

  return {
    role: "assistant",
    content: assistantContentParts,
  };
}

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
    await runtime.idle();
  }
}

export async function invokeToolCall(
  runtime: IRuntime,
  space: MemorySpace,
  toolDef: Cell<Schema<typeof LLMToolSchema>> | undefined,
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
        result,
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

  const cancel = result.sink((r) => {
    r !== undefined && resolve(r);
  });
  let resultValue = await promise;
  cancel();

  if (pattern) {
    runtime.runner.stop(result);
  } else {
    await runtime.idle();
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
    let output: any;
    if (toolResult.error) {
      output = { type: "error-text", value: toolResult.error };
    } else if (toolResult.result === undefined || toolResult.result === null) {
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

function extractTextFromContent(content: LLMResponse["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => (part as BuiltInLLMTextPart).text)
      .join("");
  }
  return "";
}

/**
 * Execute an LLM request with tool call support.
 *
 * This function handles the full tool call loop:
 * 1. Send initial request to LLM
 * 2. If response contains tool calls, execute them
 * 3. Add tool results to messages and continue
 * 4. Repeat until no tool calls (or max iterations)
 * 5. Return final response with tool call logs
 *
 * @param client - LLM client instance
 * @param runtime - Runtime instance
 * @param space - Memory space
 * @param toolsCell - Cell containing tool definitions
 * @param initialRequest - Initial LLM request parameters
 * @param abortSignal - Optional abort signal
 * @returns Final response, tool call logs, and iteration count
 */
export async function executeWithToolCalls(
  client: LLMClient,
  runtime: IRuntime,
  space: MemorySpace,
  toolsCell: Cell<any>,
  initialRequest: LLMRequest,
  abortSignal?: AbortSignal,
): Promise<ExecuteWithToolCallsResult> {
  const toolCatalog = await buildToolCatalog(runtime, toolsCell);
  const toolCallLogs: ToolCallLog[] = [];

  let currentMessages = [...initialRequest.messages];
  let iteration = 0;
  let finalResponse: LLMResponse;

  while (iteration < MAX_TOOL_CALL_ITERATIONS) {
    iteration++;

    // Prepare request with current messages
    const request: LLMRequest = {
      ...initialRequest,
      messages: currentMessages,
      tools: toolCatalog.llmTools,
    };

    // Call LLM (no streaming for generate* nodes)
    const llmResponse = await client.sendRequest(
      request,
      () => {},
      abortSignal,
    );

    // Extract tool calls if any
    const toolCallParts = extractToolCallParts(llmResponse.content);

    if (toolCallParts.length === 0) {
      // No tool calls - we're done
      finalResponse = llmResponse;
      break;
    }

    // Execute tool calls
    logger.info(
      `Iteration ${iteration}: Executing ${toolCallParts.length} tool calls`,
    );
    const toolResults = await executeToolCalls(
      runtime,
      space,
      toolCatalog,
      toolCallParts,
    );

    // Log this iteration
    toolCallLogs.push({
      iteration,
      toolCalls: toolResults.map((r) => ({
        name: r.toolName,
        input: toolCallParts.find((p) => p.toolCallId === r.id)?.input,
        result: r.result,
        error: r.error,
      })),
      llmResponse: extractTextFromContent(llmResponse.content),
    });

    // Build messages for next iteration
    const assistantMessage = buildAssistantMessage(
      llmResponse.content,
      toolCallParts,
    );
    const toolResultMessages = createToolResultMessages(toolResults);

    // Add to messages array
    currentMessages = [
      ...currentMessages,
      assistantMessage,
      ...toolResultMessages,
    ];
  }

  if (iteration >= MAX_TOOL_CALL_ITERATIONS) {
    logger.warn(
      `Reached max tool call iterations (${MAX_TOOL_CALL_ITERATIONS})`,
    );
    // Use last response even if incomplete
    finalResponse = finalResponse!;
  }

  return {
    finalResponse: finalResponse!,
    toolCallLogs,
    iterationCount: iteration,
  };
}

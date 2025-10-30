import {
  DEFAULT_MODEL_NAME,
  LLMClient,
  LLMRequest,
  LLMToolCall,
} from "@commontools/llm";
import type {
  BuiltInLLMMessage,
  BuiltInLLMParams,
  BuiltInLLMTextPart,
  BuiltInLLMToolCallPart,
  JSONSchema,
  Schema,
} from "commontools";
import { getLogger } from "@commontools/utils/logger";
import { isBoolean, isObject } from "@commontools/utils/types";
import type { Cell, MemorySpace, Stream } from "../cell.ts";
import { isStream } from "../cell.ts";
import { ID, NAME, type Recipe, TYPE } from "../builder/types.ts";
import type { Action } from "../scheduler.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  debugTransactionWrites,
  formatTransactionSummary,
} from "../storage/transaction-summary.ts";
import { parseLink } from "../link-utils.ts";
// Avoid importing from @commontools/charm to prevent circular deps in tests

const logger = getLogger("llm-dialog", {
  enabled: true,
  level: "info",
});

const client = new LLMClient();
const REQUEST_TIMEOUT = 1000 * 60 * 5; // 5 minutes

/**
 * Slugifies a string to match the pattern ^[a-zA-Z0-9_-]{1,128}$
 * Replaces spaces and invalid characters with underscores, truncates to 128 chars
 */
function slugify(str: string): string {
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

// --------------------
// Helper types + utils
// --------------------

type ToolKind = "handler" | "cell" | "pattern";

function normalizeInputSchema(schemaLike: unknown): JSONSchema {
  let inputSchema: any = schemaLike;
  if (isBoolean(inputSchema)) {
    inputSchema = {
      type: "object",
      properties: {},
      additionalProperties: inputSchema,
    };
  }
  if (!isObject(inputSchema)) inputSchema = { type: "object" };
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

const LLMMessageSchema = {
  type: "object",
  properties: {
    role: { type: "string" },
    content: {
      anyOf: [{
        type: "array",
        items: {
          anyOf: [{
            type: "object",
            properties: {
              // This should be anyOf with const values for type
              type: { type: "string" },
              text: { type: "string" },
              image: { type: "string" },
              toolCallId: { type: "string" },
              toolName: { type: "string" },
              input: { type: "object" },
              output: {},
            },
            required: ["type"],
          }, { type: "string" }],
        },
      }, { type: "string" }],
    },
  },
  required: ["role", "content"],
} as const satisfies JSONSchema;

const LLMToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
    handler: {
      // Deliberately no schema, so it gets populated from the handler
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
      // Accept whole charm - its own schema defines its handlers
      asCell: true,
    },
  },
  required: [],
} as const satisfies JSONSchema;

const LLMParamsSchema = {
  type: "object",
  properties: {
    messages: { type: "array", items: LLMMessageSchema, default: [] },
    model: { type: "string" },
    maxTokens: { type: "number" },
    system: { type: "string" },
    tools: { type: "object", additionalProperties: LLMToolSchema, default: {} },
  },
  required: ["messages"],
} as const satisfies JSONSchema;

const resultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    addMessage: { ...LLMMessageSchema, asStream: true },
    cancelGeneration: { asStream: true },
    flattenedTools: { type: "object", default: {} },
  },
  required: ["pending", "addMessage", "cancelGeneration"],
} as const satisfies JSONSchema;

const internalSchema = {
  type: "object",
  properties: {
    requestId: { type: "string" },
    lastActivity: { type: "number" },
  },
  required: ["requestId", "lastActivity"],
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

type ToolCatalog = {
  llmTools: Record<string, { description: string; inputSchema: JSONSchema }>;
  legacyToolCells: Map<string, Cell<Schema<typeof LLMToolSchema>>>;
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
 * Flattens tools by extracting handlers from charm-based tools.
 * Converts { charm: ... } entries into individual handler entries.
 *
 * @param toolsCell - Cell containing the tools
 * @param toolHandlers - Optional map to populate with handler references for invocation
 * @returns Flattened tools object with handler/pattern entries
 */
function flattenTools(
  toolsCell: Cell<any>,
  runtime?: IRuntime,
): Record<
  string,
  {
    handler?: any;
    description: string;
    inputSchema?: JSONSchema;
    internal?: { kind: ToolKind; path: string[]; charmName: string };
  }
> {
  const flattened: Record<string, any> = {};
  const { legacy, charms } = collectToolEntries(toolsCell);

  for (const entry of legacy) {
    const passThrough: Record<string, unknown> = { ...entry.tool };
    if (
      passThrough.inputSchema && typeof passThrough.inputSchema === "object"
    ) {
      passThrough.inputSchema = stripInjectedResult(passThrough.inputSchema);
    }
    flattened[entry.name] = passThrough;
  }

  for (const entry of charms) {
    let schema: JSONSchema | undefined =
      getLoadedRecipeResultSchema(runtime, entry.charm) ??
        buildMinimalSchemaFromValue(entry.charm);
    schema = schema ?? ({} as JSONSchema);
    const schemaString = stringifySchemaGuarded(schema);
    const charmTools = createCharmToolDefinitions(
      entry.charmName,
      schemaString,
    );

    flattened[charmTools.read.name] = {
      description: charmTools.read.description,
      inputSchema: charmTools.read.inputSchema,
      internal: { kind: "cell", path: [], charmName: entry.charmName },
    };

    flattened[charmTools.run.name] = {
      description: charmTools.run.description,
      inputSchema: charmTools.run.inputSchema,
      internal: { kind: "handler", path: [], charmName: entry.charmName },
    };
  }

  return flattened;
}

async function buildToolCatalog(
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

function resolveToolCall(
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

function extractToolCallParts(
  content: BuiltInLLMMessage["content"],
): BuiltInLLMToolCallPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is BuiltInLLMToolCallPart =>
    (part as BuiltInLLMToolCallPart).type === "tool-call"
  );
}

function buildAssistantMessage(
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

type ToolCallExecutionResult = {
  id: string;
  toolName: string;
  result?: any;
  error?: string;
};

async function executeToolCalls(
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

function createToolResultMessages(
  results: ToolCallExecutionResult[],
): BuiltInLLMMessage[] {
  return results.map((toolResult) => ({
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: toolResult.id,
      toolName: toolResult.toolName || "unknown",
      output: toolResult.error
        ? { type: "error-text", value: toolResult.error }
        : toolResult.result,
    }],
  }));
}

export const llmDialogTestHelpers = {
  createCharmToolDefinitions,
  normalizeCharmPathSegments,
  extractRunArguments,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
};

/**
 * Performs a mutation on the storage if the pending flag is active and the
 * request ID matches. This ensures the pending flag has final say over whether
 * the LLM continues generating.
 *
 * @param runtime - The runtime instance
 * @param pending - Cell containing the pending state
 * @param internal - Cell containing the internal state
 * @param requestId - The request ID
 * @param action - The mutation action to perform if pending is true
 * @returns true if the action was performed, false otherwise
 */
async function safelyPerformUpdate(
  runtime: IRuntime,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  action: (tx: IExtendedStorageTransaction) => void,
) {
  let success = false;
  const error = await runtime.editWithRetry((tx) => {
    if (
      pending.withTx(tx).get() &&
      internal.withTx(tx).key("requestId").get() === requestId
    ) {
      action(tx);
      internal.withTx(tx).key("lastActivity").set(Date.now());
      success = true;
    } else {
      // We might have flagged success as true in a previous call, but if the
      // retry flow lands us here, it means it wasn't written and that now
      // the requestId has changed.
      success = false;
    }
  });

  return !error && success;
}

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
 * @param parentCell - The parent cell context for the tool execution
 * @param toolDef - Cell containing the tool definition with handler
 * @param toolCall - The LLM tool call containing id, name, and arguments
 * @param charmHandler - Optional handler for charm-extracted tools
 * @returns Promise that resolves to the tool execution result
 */
async function invokeToolCall(
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
  // FIXME(bf): in practice, toolCall has toolCall.toolCallId not .id
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
        // Debug: uncomment to see what's actually in the transaction
        // logger.info("Transaction details:", debugTransactionWrites(completedTx));

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
  const resultValue = await promise;
  cancel();

  if (pattern) {
    // stop it now that we have the result
    runtime.runner.stop(result);
  } else {
    await runtime.idle(); // maybe pointless
  }

  return { type: "json", value: resultValue ?? "OK" }; // if there was no return value, just tell the LLM it worked
}

/**
 * Run a (tool using) dialog with an LLM.
 *
 * @param messages - list of messages representing the conversation. This is mutated by the internal process.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param maxTokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, addMessage: (message: BuiltInLLMMessage) => void } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llmDialog(
  inputsCell: Cell<BuiltInLLMParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  const inputs = inputsCell.asSchema(LLMParamsSchema);

  // Helper function to create and register handlers
  const createHandler = <T>(
    stream: Stream<T>,
    handler: (tx: IExtendedStorageTransaction, event: T) => void,
  ) => {
    addCancel(
      runtime.scheduler.addEventHandler(handler, parseLink(stream)),
    );
  };

  let cellsInitialized = false;
  let result: Cell<Schema<typeof resultSchema>>;
  let internal: Cell<Schema<typeof internalSchema>>;
  let requestId: string | undefined = undefined;
  let abortController: AbortController | undefined = undefined;

  // This is called when the recipe containing this node is being stopped.
  addCancel(() => {
    // Abort the request if it's still pending.
    abortController?.abort("Recipe stopped");

    const tx = runtime.edit();

    // If the pending request is ours, set pending to false and clear the requestId.
    if (internal.withTx(tx).key("requestId").get() === requestId) {
      result.withTx(tx).key("pending").set(false);
      internal.withTx(tx).key("requestId").set("");
    }

    // Since we're aborting, don't retry. If the above fails, it's because the
    // requestId was already changing under us.
    tx.commit();
  });

  return (tx: IExtendedStorageTransaction) => {
    // Setup cells on first run.
    if (!cellsInitialized) {
      // Create result cell. The predictable cause means that it'll map to
      // previously existing results. Note that we might not yet have it loaded
      // and that this function will be called again once the data is loaded
      // (but this if branch will be skipped then).
      result = runtime.getCell(
        parentCell.space,
        { llmDialog: { result: cause } },
        resultSchema,
        tx,
      );
      result.sync(); // Kick off sync, no need to await

      // Create another cell to store the internal state. This isn't returned to
      // the caller. But again, the predictable cause means all instances tied
      // to the same input cells will coordinate via the same cell.
      internal = runtime.getCell(
        parentCell.space,
        { llmDialog: { internal: cause } },
        internalSchema,
        tx,
      );
      internal.sync(); // Kick off sync, no need to await

      const pending = result.key("pending");

      // Write the stream markers into the result cell. This write might fail
      // (since the original data wasn't loaded yet), but that's ok, since in
      // that case another instance already wrote these.
      //
      // We are carrying the existing pending state over, in case the result
      // cell was already loaded. We don't want to overwrite it.
      result.setRaw({
        ...result.getRaw(),
        addMessage: { $stream: true },
        cancelGeneration: { $stream: true },
      });

      // Declare `addMessage` handler and register
      createHandler<BuiltInLLMMessage>(
        // Cast is necessary as .key doesn't yet correctly handle Stream<>
        result.key("addMessage") as unknown as Stream<BuiltInLLMMessage>,
        (tx: IExtendedStorageTransaction, event: BuiltInLLMMessage) => {
          if (
            pending.withTx(tx).get() && (
              internal.withTx(tx).key("lastActivity").get() >
                Date.now() - REQUEST_TIMEOUT
            )
          ) {
            // For now, let's drop messages added while request is pending for
            // less than five minutes. Add message UI should either be disabled
            // or change the send button to be a stop button.
            return;
          }

          // Before starting request, set pending and append the new message.
          pending.withTx(tx).set(true);
          inputs.key("messages").withTx(tx).push(
            {
              ...event,
              // Add ID manually, as for built-ins this isn't automated
              // TODO(seefeld): Once we have event ids, it should be that.
              [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
              // Cast because we can't yet express ArrayBuffer in JSON Schema
            } as Schema<
              typeof LLMMessageSchema
            >,
          );

          // Set up new request (abort existing ones just in case) by allocating
          // a new request Id and setting up a new abort controller.
          abortController?.abort("New request started");
          abortController = new AbortController();
          requestId = crypto.randomUUID();
          internal.withTx(tx).set({
            requestId,
            lastActivity: Date.now(),
          });

          // Start a new request. This will start an async operation that will
          // outlive this handler call.
          startRequest(
            tx,
            runtime,
            parentCell.space,
            cause,
            inputs,
            pending,
            internal,
            requestId,
            abortController.signal,
          );
        },
      );

      // Declare `cancelGeneration` handler and register
      createHandler<void>(
        result.key("cancelGeneration") as unknown as Stream<any>,
        (tx: IExtendedStorageTransaction, _event: void) => {
          // Cancel request by setting pending to false. This will trigger the
          // code below to be executed in all tabs.
          pending.withTx(tx).set(false);
        },
      );

      sendResult(tx, result);
      cellsInitialized = true;
    }

    // This will remain the reactive part. It will be called whenever one of the
    // read cells change. This is why it's important to do the read before the
    // "&& requestId" part: Otherwise, we'd run this once without requestId and
    // so read no cells and then this wouldn't be called again.
    //
    // Note: If this were sandboxed code, this part would naturally read this
    // cell as it's the only way to get to requestId, here we are passing it
    // around on the side.

    // Update flattened tools whenever tools change
    const toolsCell = inputs.key("tools");
    // Ensure reactivity: register a read of tools with this tx
    toolsCell.withTx(tx).get();
    const flattened = flattenTools(toolsCell, runtime);
    result.withTx(tx).key("flattenedTools").set(flattened as any);

    if (
      (!result.withTx(tx).key("pending").get() ||
        requestId !== internal.withTx(tx).key("requestId").get()) && requestId
    ) {
      // We have a pending request and either something set pending to false or
      // another request started, so we have to abort this one.
      abortController?.abort("Another request started");
      requestId = undefined;
    }
  };
}

async function startRequest(
  tx: IExtendedStorageTransaction,
  runtime: IRuntime,
  space: MemorySpace,
  cause: any,
  inputs: Cell<Schema<typeof LLMParamsSchema>>,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  abortSignal: AbortSignal,
) {
  const { system, maxTokens, model } = inputs.get();

  const messagesCell = inputs.key("messages");
  const toolsCell = inputs.key("tools");

  // No need to flatten here; UI handles flattened tools reactively

  const toolCatalog = await buildToolCatalog(runtime, toolsCell);

  const llmParams: LLMRequest = {
    system: system ?? "",
    messages: messagesCell.withTx(tx).get() as BuiltInLLMMessage[],
    maxTokens: maxTokens,
    stream: true,
    model: model ?? DEFAULT_MODEL_NAME,
    metadata: { context: "charm" },
    cache: true,
    tools: toolCatalog.llmTools,
  };

  // TODO(bf): sendRequest must be given a callback, even if it does nothing
  const resultPromise = client.sendRequest(llmParams, () => {}, abortSignal);

  resultPromise
    .then(async (llmResult) => {
      // Extract tool calls from content if it's an array
      const hasToolCalls = Array.isArray(llmResult.content) &&
        llmResult.content.some((part) => part.type === "tool-call");

      if (hasToolCalls) {
        try {
          const llmContent = llmResult.content as BuiltInLLMMessage["content"];
          const toolCallParts = extractToolCallParts(llmContent);
          const assistantMessage = buildAssistantMessage(
            llmContent,
            toolCallParts,
          );
          const toolResults = await executeToolCalls(
            runtime,
            space,
            toolCatalog,
            toolCallParts,
          );
          const newMessages: BuiltInLLMMessage[] = [
            assistantMessage,
            ...createToolResultMessages(toolResults),
          ];

          newMessages.forEach((message) => {
            (message as BuiltInLLMMessage & { [ID]: unknown })[ID] = {
              llmDialog: { message: cause, id: crypto.randomUUID() },
            };
          });

          const success = await safelyPerformUpdate(
            runtime,
            pending,
            internal,
            requestId,
            (tx) => {
              messagesCell.withTx(tx).push(
                ...(newMessages as Schema<typeof LLMMessageSchema>[]),
              );
            },
          );

          if (success) {
            logger.info("Continuing conversation after tool calls...");

            const continueTx = runtime.edit();
            startRequest(
              continueTx,
              runtime,
              space,
              cause,
              inputs,
              pending,
              internal,
              requestId,
              abortSignal,
            );
            continueTx.commit();
          } else {
            logger.info("Skipping write: pending=false or request changed");
          }
        } catch (error: unknown) {
          console.error(error);
        }
      } else {
        // No tool calls, just add the assistant message
        const assistantMessage = {
          [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
          role: "assistant",
          content: llmResult.content,
        } satisfies BuiltInLLMMessage & { [ID]: unknown };

        // Ignore errors here, it probably means something else took over.
        await safelyPerformUpdate(
          runtime,
          pending,
          internal,
          requestId,
          (tx) => {
            messagesCell.withTx(tx).push(
              assistantMessage as Schema<typeof LLMMessageSchema>,
            );
            pending.withTx(tx).set(false);
          },
        );
      }
    })
    .catch((error: unknown) => {
      console.error("Error generating data", error);
      runtime.editWithRetry((tx) => {
        pending.withTx(tx).set(false);
      });
    });
}

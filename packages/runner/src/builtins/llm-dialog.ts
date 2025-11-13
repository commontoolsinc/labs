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

type ToolCatalog = {
  llmTools: Record<string, { description: string; inputSchema: JSONSchema }>;
  legacyToolCells: Map<string, Cell<Schema<typeof LLMToolSchema>>>;
  charmMap: Map<string, Cell<any>>;
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

const READ_TOOL_NAME = "read";
const RUN_TOOL_NAME = "run";
const SCHEMA_TOOL_NAME = "schema";

const READ_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Target path in the form Charm/child/grandchild.",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

const RUN_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Target handler path in the form Charm/handler/path.",
    },
    args: {
      type: "object",
      description: "Arguments passed to the handler.",
    },
  },
  required: ["path"],
  additionalProperties: true,
};

const SCHEMA_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Name of the attached charm.",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

function ensureString(
  value: unknown,
  field: string,
  example: string,
): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(
        `${field} must be a non-empty string, e.g. "${example}".`,
      );
    }
    return trimmed;
  }
  throw new Error(`${field} must be a string, e.g. "${example}".`);
}

function extractStringField(
  input: unknown,
  field: string,
  example: string,
): string {
  if (typeof input === "string") {
    return ensureString(input, field, example);
  }
  if (input && typeof input === "object") {
    const value = (input as Record<string, unknown>)[field];
    return ensureString(value, field, example);
  }
  throw new Error(`${field} must be a non-empty string, e.g. "${example}".`);
}

function parseTargetString(
  target: string,
): { charmName: string; pathSegments: string[] } {
  const cleaned = target.split("/").map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (cleaned.length === 0) {
    throw new Error(
      'target must include a charm name, e.g. "Charm/path".',
    );
  }
  const [charmName, ...pathSegments] = cleaned;
  return { charmName, pathSegments };
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

  if (charms.length > 0) {
    const names = charms.map((entry) => entry.charmName);
    const list = names.join(", ");
    const availability = list
      ? `Available charms: ${list}.`
      : "No charms attached.";

    flattened[READ_TOOL_NAME] = {
      description:
        "Read data from an attached charm using a target path like " +
        '"Charm/result/path". ' + availability,
      inputSchema: READ_INPUT_SCHEMA,
    };
    flattened[RUN_TOOL_NAME] = {
      description:
        "Invoke a handler on an attached charm. Provide the target " +
        'path like "Charm/handlers/doThing" plus args if required. ' +
        availability,
      inputSchema: RUN_INPUT_SCHEMA,
    };
    // flattened[SCHEMA_TOOL_NAME] = {
    //   description:
    //     "Return the JSON schema for an attached charm to understand " +
    //     "available fields and handlers. " + availability,
    //   inputSchema: SCHEMA_INPUT_SCHEMA,
    // };
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
  const charmMap = new Map<string, Cell<any>>();

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

  const charmNames: string[] = [];
  for (const entry of charms) {
    charmMap.set(entry.charmName, entry.charm);
    charmNames.push(entry.charmName);
  }

  if (charmNames.length > 0) {
    const list = charmNames.join(", ");
    const availability = list
      ? `Available charms: ${list}.`
      : "No charms attached.";

    llmTools[READ_TOOL_NAME] = {
      description: "Read data from an attached charm using a path like " +
        '"Charm/result/path". Charm schemas are provided in the system prompt. ' +
        availability,
      inputSchema: READ_INPUT_SCHEMA,
    };
    llmTools[RUN_TOOL_NAME] = {
      description:
        "Run a handler on an attached charm. Provide the path like " +
        '"Charm/handlers/doThing" and optionally args. Charm schemas are ' +
        "provided in the system prompt. " + availability,
      inputSchema: RUN_INPUT_SCHEMA,
    };
    llmTools[SCHEMA_TOOL_NAME] = {
      description:
        "Return the JSON schema for an attached charm to discover its " +
        "fields and handlers. Note: schemas are also provided in the system " +
        "prompt for convenience. " + availability,
      inputSchema: SCHEMA_INPUT_SCHEMA,
    };
  }

  return { llmTools, legacyToolCells, charmMap };
}

/**
 * Build a formatted documentation string describing all attached charm schemas.
 * This is appended to the system prompt so the LLM has immediate context about
 * available charms without needing to call schema() first.
 */
async function buildCharmSchemasDocumentation(
  runtime: IRuntime,
  charmMap: Map<string, Cell<any>>,
): Promise<string> {
  if (charmMap.size === 0) {
    return "";
  }

  const schemaEntries: string[] = [];

  for (const [charmName, charm] of charmMap.entries()) {
    try {
      const schema = await getCharmResultSchemaAsync(runtime, charm);
      if (schema) {
        const schemaJson = JSON.stringify(schema, null, 2);
        schemaEntries.push(`## ${charmName}\n\`\`\`json\n${schemaJson}\n\`\`\``);
      }
    } catch (e) {
      logger.warn(`Failed to get schema for charm ${charmName}:`, e);
    }
  }

  if (schemaEntries.length === 0) {
    return "";
  }

  return `\n\n# Attached Charm Schemas\n\nThe following charms are attached and available via read() and run() tools:\n\n${schemaEntries.join("\n\n")}`;
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
    charm: Cell<any>;
    extraParams?: Record<string, unknown>;
    pattern?: Readonly<Recipe>;
    mode: "read" | "run" | "schema";
    targetSegments?: string[];
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

  if (
    name === READ_TOOL_NAME || name === RUN_TOOL_NAME ||
    name === SCHEMA_TOOL_NAME
  ) {
    if (catalog.charmMap.size === 0) {
      throw new Error("No charm attachments available.");
    }
    if (name === SCHEMA_TOOL_NAME) {
      const charmName = extractStringField(
        toolCallPart.input,
        "path",
        "Charm",
      );
      const charm = catalog.charmMap.get(charmName);
      if (!charm) {
        throw new Error(
          `Unknown charm "${charmName}". Use listAttachments for options.`,
        );
      }
      return {
        charmMeta: { charm, mode: "schema" },
        call: { id, name, input: { charm: charmName } },
      };
    }

    const target = extractStringField(
      toolCallPart.input,
      "path",
      "Charm/path",
    );
    const { charmName, pathSegments } = parseTargetString(target);
    const charm = catalog.charmMap.get(charmName);
    if (!charm) {
      throw new Error(
        `Unknown charm "${charmName}". Use listAttachments for options.`,
      );
    }
    const baseLink = charm.getAsNormalizedFullLink();
    const link = {
      ...baseLink,
      path: [
        ...baseLink.path,
        ...pathSegments.map((segment) => segment.toString()),
      ],
    };

    if (name === READ_TOOL_NAME) {
      const ref = runtime.getCellFromLink(link);
      if (isStream(ref)) {
        throw new Error('path resolves to a handler; use run("Charm/path").');
      }
      return {
        charmMeta: {
          charm,
          mode: "read",
          targetSegments: pathSegments,
        },
        call: { id, name, input: { path: target } },
      };
    }

    const ref: Cell<any> = runtime.getCellFromLink(link);
    if (isStream(ref)) {
      return {
        charmMeta: { handler: ref as any, charm, mode: "run" },
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
          charm,
          mode: "run",
        },
        call: {
          id,
          name,
          input: extractRunArguments(toolCallPart.input),
        },
      };
    }

    throw new Error("target does not resolve to a handler stream or pattern.");
  }

  throw new Error("Tool has neither pattern nor handler");
}

function extractToolCallParts(
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
function hasValidContent(content: BuiltInLLMMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((part) => {
      if (part.type === "tool-call" || part.type === "tool-result") {
        return true;
      }
      if (part.type === "text") {
        return (part as BuiltInLLMTextPart).text?.trim().length > 0;
      }
      return false;
    });
  }

  return false;
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

export const llmDialogTestHelpers = {
  parseTargetString,
  extractStringField,
  extractRunArguments,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
};

/**
 * Shared tool execution utilities for use by other LLM built-ins (llm, generateText).
 * These functions handle tool catalog building, tool call resolution, and execution.
 */
export const llmToolExecutionHelpers = {
  buildToolCatalog,
  executeToolCalls,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
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
    charm: Cell<any>;
    extraParams?: Record<string, unknown>;
    pattern?: Readonly<Recipe>;
    mode: "read" | "run" | "schema";
    targetSegments?: string[];
  },
) {
  if (charmMeta?.mode === "schema") {
    const schema = await getCharmResultSchemaAsync(runtime, charmMeta.charm) ??
      {};
    const value = JSON.parse(JSON.stringify(schema ?? {}));
    return { type: "json", value };
  }

  if (charmMeta?.mode === "read") {
    const segments = charmMeta.targetSegments ?? [];
    const realized = charmMeta.charm.getAsQueryResult(segments);
    const value = JSON.parse(JSON.stringify(realized));
    return { type: "json", value };
  }

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

    // Only write if changed to avoid concurrent write conflicts
    const currentFlattened = result.withTx(tx).key("flattenedTools").get();
    const flattenedStr = JSON.stringify(flattened);
    const currentStr = JSON.stringify(currentFlattened);

    if (flattenedStr !== currentStr) {
      result.withTx(tx).key("flattenedTools").set(flattened as any);
    }

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

  // Build charm schemas documentation and append to system prompt
  const charmSchemasDocs = await buildCharmSchemasDocumentation(
    runtime,
    toolCatalog.charmMap,
  );
  const augmentedSystem = (system ?? "") + charmSchemasDocs;

  const llmParams: LLMRequest = {
    system: augmentedSystem,
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
      // Validate that the response has valid content
      if (!hasValidContent(llmResult.content)) {
        // LLM returned empty or invalid content (e.g., stream aborted mid-flight,
        // or AI SDK bug with empty text blocks). Insert a proper error message
        // instead of storing invalid content.
        logger.warn("LLM returned invalid/empty content, adding error message");
        const errorMessage = {
          [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
          role: "assistant",
          content:
            "I encountered an error generating a response. Please try again.",
        } satisfies BuiltInLLMMessage & { [ID]: unknown };

        await safelyPerformUpdate(
          runtime,
          pending,
          internal,
          requestId,
          (tx) => {
            messagesCell.withTx(tx).push(
              errorMessage as Schema<typeof LLMMessageSchema>,
            );
            pending.withTx(tx).set(false);
          },
        );
        return;
      }

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

          // Validate that we have a result for every tool call with matching IDs
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
            // Add error message instead of invalid partial results
            const errorMessage = {
              [ID]: { llmDialog: { message: cause, id: crypto.randomUUID() } },
              role: "assistant",
              content: "Some tool calls failed to execute. Please try again.",
            } satisfies BuiltInLLMMessage & { [ID]: unknown };

            await safelyPerformUpdate(
              runtime,
              pending,
              internal,
              requestId,
              (tx) => {
                messagesCell.withTx(tx).push(
                  errorMessage as Schema<typeof LLMMessageSchema>,
                );
                pending.withTx(tx).set(false);
              },
            );
            return;
          }

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

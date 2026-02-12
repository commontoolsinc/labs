import { isRecord } from "@commontools/utils/types";
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
  BuiltInLLMTool,
  BuiltInLLMToolCallPart,
  JSONSchema,
} from "commontools";
import type { Schema } from "@commontools/api/schema";
import {
  LLMMessageSchema,
  LLMParamsSchema,
  LLMReducedToolSchema,
  LLMToolSchema,
} from "./llm-schemas.ts";
import { getLogger } from "@commontools/utils/logger";
import { isBoolean, isObject } from "@commontools/utils/types";
import type { Cell, MemorySpace, Stream } from "../cell.ts";
import { isCell, isStream } from "../cell.ts";
import { ID, NAME, type Recipe } from "../builder/types.ts";
import type { Action } from "../scheduler.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { schemaToTypeString } from "../schema-format.ts";
import { formatTransactionSummary } from "../storage/transaction-summary.ts";
import {
  createLLMFriendlyLink,
  matchLLMFriendlyLink,
  parseLink,
  parseLLMFriendlyLink,
} from "../link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { ContextualFlowControl } from "../cfc.ts";

// Avoid importing from @commontools/piece to prevent circular deps in tests

const logger = getLogger("llm-dialog", {
  enabled: false,
  level: "info",
});

const client = new LLMClient();
const REQUEST_TIMEOUT = 1000 * 60 * 5; // 5 minutes
const TOOL_CALL_TIMEOUT = 1000 * 30 * 1; // 30 seconds

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
 * Resolve a piece's result schema similarly to PieceManager.#getResultSchema:
 * - Prefer a non-empty recipe.resultSchema if recipe is loaded
 * - Otherwise derive a simple object schema from the current value
 */
function getCellSchema(
  cell: Cell<unknown>,
): JSONSchema | undefined {
  // Extract schema from cell, including from resultSchema of associated pattern
  const { schema } = cell.asSchemaFromLinks().getAsNormalizedFullLink();

  if (schema !== undefined) {
    return schema;
  }

  // Fall back to minimal schema based on current value
  return buildMinimalSchemaFromValue(cell);
}

function buildMinimalSchemaFromValue(piece: Cell<any>): JSONSchema | undefined {
  try {
    const resultValue = piece.asSchema().get();
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

/**
 * @deprecated Use schemaToTypeString instead for cleaner TypeScript-like output.
 *
 * Simplifies a schema for LLM context documentation.
 * Removes $defs and $ref which can make schemas very large with recursive types.
 * Preserves essential type information including wrapper markers (asStream, asCell, asOpaque),
 * nested properties, required arrays, and small enums.
 *
 * @param schema - The schema to simplify
 * @param depth - Current recursion depth (default 0)
 * @param maxDepth - Maximum recursion depth (default 3)
 */
function simplifySchemaForContext(
  schema: JSONSchema,
  depth: number = 0,
  maxDepth: number = 3,
): JSONSchema {
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }

  const schemaObj = schema as Record<string, unknown>;

  // At max depth, return a minimal schema preserving only type and wrapper markers
  if (depth >= maxDepth) {
    const minimal: Record<string, unknown> = {};
    if (schemaObj.type) minimal.type = schemaObj.type;
    if (schemaObj.asStream) minimal.asStream = schemaObj.asStream;
    if (schemaObj.asCell) minimal.asCell = schemaObj.asCell;
    if (schemaObj.asOpaque) minimal.asOpaque = schemaObj.asOpaque;
    return minimal as JSONSchema;
  }

  const simplified: Record<string, unknown> = {};

  // Semantic markers and essential keys to always preserve
  const PRESERVE_KEYS = [
    "type",
    "description",
    "asStream",
    "asCell",
    "asOpaque",
    "default",
    "required",
    "additionalProperties",
  ];

  // Maximum enum values to preserve (to prevent bloat)
  const MAX_ENUM_VALUES = 10;

  for (const [key, value] of Object.entries(schemaObj)) {
    // Skip $defs and $ref - these can be huge with recursive types
    if (key === "$defs" || key === "$ref") {
      continue;
    }

    // Skip $-prefixed keys (like $UI schemas) - these are internal/VDOM
    if (key.startsWith("$")) {
      continue;
    }

    // Handle properties recursively
    if (key === "properties" && typeof value === "object" && value !== null) {
      const simplifiedProps: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value)) {
        // Skip $-prefixed properties ($UI, $TYPE, etc.) - these are internal/VDOM
        if (propKey.startsWith("$")) {
          continue;
        }
        if (typeof propValue === "object" && propValue !== null) {
          simplifiedProps[propKey] = simplifySchemaForContext(
            propValue as JSONSchema,
            depth + 1,
            maxDepth,
          );
        } else {
          simplifiedProps[propKey] = propValue;
        }
      }
      simplified[key] = simplifiedProps;
      continue;
    }

    // Handle items recursively (for arrays)
    if (key === "items" && typeof value === "object" && value !== null) {
      simplified[key] = simplifySchemaForContext(
        value as JSONSchema,
        depth + 1,
        maxDepth,
      );
      continue;
    }

    // Handle enum - preserve if small, otherwise truncate
    if (key === "enum" && Array.isArray(value)) {
      if (value.length <= MAX_ENUM_VALUES) {
        simplified[key] = value;
      } else {
        // Truncate large enums and add indicator
        simplified[key] = [...value.slice(0, MAX_ENUM_VALUES), "..."];
      }
      continue;
    }

    // Handle anyOf/oneOf/allOf recursively
    if (
      (key === "anyOf" || key === "oneOf" || key === "allOf") &&
      Array.isArray(value)
    ) {
      simplified[key] = value.map((v) =>
        typeof v === "object" && v !== null
          ? simplifySchemaForContext(v as JSONSchema, depth + 1, maxDepth)
          : v
      );
      continue;
    }

    // Preserve keys from PRESERVE_KEYS list
    if (PRESERVE_KEYS.includes(key)) {
      simplified[key] = value;
      continue;
    }

    // Preserve other primitive values, but skip complex objects not handled above
    if (typeof value !== "object" || value === null) {
      simplified[key] = value;
    }
  }

  return simplified as JSONSchema;
}

/**
 * Traverses a value and serializes any cells mentioned to our LLM-friendly JSON
 * link object format.
 *
 * @param value - The value to traverse and serialize
 * @param schema - The schema for the value
 * @param seen - Set of already-visited values (for cycle detection)
 * @param contextSpace - The current execution space (for cross-space link encoding)
 * @returns The serialized value
 */
function traverseAndSerialize(
  value: unknown,
  schema: JSONSchema | undefined,
  seen: Set<unknown> = new Set(),
  contextSpace?: MemorySpace,
): unknown {
  if (!isRecord(value)) return value;

  // If we encounter an `any` schema, turn value into a cell link
  if (
    seen.size > 0 && schema !== undefined &&
    ContextualFlowControl.isTrueSchema(schema) &&
    isCellResultForDereferencing(value)
  ) {
    // Next step will turn this into a link
    value = getCellOrThrow(value);
  }

  // Turn cells into a link, unless they are data: URIs and traverse instead
  if (isCell(value)) {
    const link = value.resolveAsCell().getAsNormalizedFullLink();
    if (link.id.startsWith("data:")) {
      return traverseAndSerialize(
        value.get(),
        schema,
        seen,
        contextSpace,
      );
    } else {
      // Use createLLMFriendlyLink to include space for cross-space cells
      return { "@link": createLLMFriendlyLink(link, contextSpace) };
    }
  }

  // If we've already seen this and it can be mapped to a cell, serialized as
  // cell link, otherwise throw (this should never happen in our cases)
  if (seen.has(value)) {
    if (isCellResultForDereferencing(value)) {
      return traverseAndSerialize(
        getCellOrThrow(value),
        schema,
        seen,
        contextSpace,
      );
    } else {
      throw new Error(
        "Cannot serialize a value that has already been seen and cannot be mapped to a cell.",
      );
    }
  }
  seen.add(value);

  const cfc = new ContextualFlowControl();

  if (Array.isArray(value)) {
    return value.map((v, index) => {
      const linkSchema = schema !== undefined
        ? cfc.schemaAtPath(schema, [index.toString()])
        : undefined;
      let result = traverseAndSerialize(
        v,
        linkSchema,
        seen,
        contextSpace,
      );
      // Decorate array entries with links that point to underlying cells, if
      // any. Ignores data: URIs, since they're not useful as links for the LLM.
      if (isRecord(result) && isCellResultForDereferencing(v)) {
        const link = getCellOrThrow(v).resolveAsCell()
          .getAsNormalizedFullLink();
        if (!link.id.startsWith("data:")) {
          result = {
            // Use createLLMFriendlyLink for cross-space support
            "@arrayEntry": createLLMFriendlyLink(link, contextSpace),
            ...result,
          };
        }
      }
      return result;
    });
  } else {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        // Skip $-prefixed properties ($UI, $TYPE, etc.) - these are internal/VDOM
        .filter(([key]) => !key.startsWith("$"))
        .map((
          [key, value],
        ) => [
          key,
          traverseAndSerialize(
            value,
            schema !== undefined ? cfc.schemaAtPath(schema, [key]) : undefined,
            seen,
            contextSpace,
          ),
        ]),
    );
  }
}

/**
 * Traverses a value and converts any of our LLM friendly JSON link object
 * format cells mentioned to actual cells.
 *
 * @param runtime - The runtime to use to get the cells
 * @param space - The space to use to get the cells
 * @param value - The value to traverse and cellify
 * @returns The cellified value
 */
function traverseAndCellify(
  runtime: Runtime,
  space: MemorySpace,
  value: unknown,
): unknown {
  // It's a valid link, if
  // - it's a record with a single key "/"
  // - the value of the "/" key is a string that matches the URI pattern
  if (
    isRecord(value) && typeof value["@link"] === "string" &&
    Object.keys(value).length === 1 && matchLLMFriendlyLink.test(value["@link"])
  ) {
    const link = parseLLMFriendlyLink(value["@link"], space);
    return runtime.getCellFromLink(link);
  }
  if (Array.isArray(value)) {
    return value.map((v) => traverseAndCellify(runtime, space, v));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, value],
      ) => [key, traverseAndCellify(runtime, space, value)]),
    );
  }
  return value;
}

const resultSchema = {
  type: "object",
  properties: {
    pending: { type: "boolean", default: false },
    addMessage: { ...LLMMessageSchema, asStream: true },
    cancelGeneration: { asStream: true },
    flattenedTools: { type: "object", default: {} },
    pinnedCells: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          name: { type: "string" },
        },
      },
    },
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

type PieceToolEntry = {
  name: string;
  piece: Cell<any>;
  pieceName: string;
  handle: string; // e.g., "/of:bafyabc123"
};

type ToolCatalog = {
  llmTools: Record<string, { description: string; inputSchema: JSONSchema }>;
  dynamicToolCells: Map<string, Cell<Schema<typeof LLMToolSchema>>>;
};

function collectToolEntries(
  toolsCell: Cell<Record<string, Schema<typeof LLMToolSchema>>>,
): { legacy: LegacyToolEntry[]; pieces: PieceToolEntry[] } {
  const tools = toolsCell.get() ?? {};
  const legacy: LegacyToolEntry[] = [];
  const pieces: PieceToolEntry[] = [];

  for (const [name, tool] of Object.entries(tools)) {
    if (tool?.piece?.get?.()) {
      const piece: Cell<any> = tool.piece;
      const pieceValue = piece.get();
      const pieceName = String(pieceValue?.[NAME] ?? name);

      // Extract handle from link
      const link = piece.getAsNormalizedFullLink();
      const handle = link.id; // Keep the "/of:..." format as the internal handle

      pieces.push({ name, piece, pieceName, handle });
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

  return { legacy, pieces };
}

const READ_TOOL_NAME = "read";
const INVOKE_TOOL_NAME = "invoke";
const SCHEMA_TOOL_NAME = "schema";
const PIN_TOOL_NAME = "pin";
const UNPIN_TOOL_NAME = "unpin";
const FINAL_RESULT_TOOL_NAME = "finalResult";
const UPDATE_ARGUMENT_TOOL_NAME = "updateArgument";

const READ_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      description:
        'Link to the cell to read. Format: { "@link": "/of:bafyabc123/path" }.',
    },
  },
  required: ["path"],
  additionalProperties: false,
};

const INVOKE_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      description:
        'Link to the handler or pattern to invoke. Format: { "@link": "/of:bafyabc123/doThing" }.',
    },
    args: {
      type: "object",
      description: "Arguments passed to the handler or pattern.",
    },
  },
  required: ["path"],
  additionalProperties: true,
};

const SCHEMA_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      description:
        'Link to the cell to inspect. Format: { "@link": "/of:bafyabc123" }.',
    },
  },
  required: ["path"],
  additionalProperties: false,
};

const PIN_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      description:
        'Link to pin for easy reference. Format: { "@link": "/of:bafyabc123" }.',
    },
    name: {
      type: "string",
      description: "Human-readable name for this pinned cell.",
    },
  },
  required: ["path", "name"],
  additionalProperties: false,
};

const UNPIN_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      description:
        'Link of the pinned cell to remove. Format: { "@link": "/of:bafyabc123" }.',
    },
  },
  required: ["path"],
  additionalProperties: false,
};

const UPDATE_ARGUMENT_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      description:
        'Link to the pattern instance to update. Format: { "@link": "/of:bafyabc123" }.',
    },
    updates: {
      type: "object",
      description:
        "Field updates to apply to the pattern's arguments. Keys are field paths (e.g., 'query' or 'config.theme'), values are new values.",
    },
  },
  required: ["path", "updates"],
  additionalProperties: false,
};

/**
 * Represents a pinned cell in the conversation.
 * Pinned cells are links of interest that the LLM can add/remove as a scratchpad.
 */
type PinnedCell = {
  path: string; // e.g., "/of:bafyabc123" or "/of:bafyabc123"
  name: string; // Human-readable name for display
};

// ============================================================================
// Path Utility Functions
// ============================================================================
// These utilities handle the conversion between LLM-facing path format (/of:...)
// and internal runtime format (of:...). The LLM sees paths with a leading slash
// to make it clear that strings are links.

function ensureString(
  value: unknown,
  field: string,
  example: string,
): string {
  if (isRecord(value) && typeof value["@link"] === "string") {
    return ensureString(value["@link"], field, example);
  }
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
 * Flattens tools by extracting handlers from piece-based tools.
 * Converts { piece: ... } entries into individual handler entries.
 *
 * @param toolsCell - Cell containing the tools
 * @param toolHandlers - Optional map to populate with handler references for invocation
 * @returns Flattened tools object with handler/pattern entries
 */
function flattenTools(
  toolsCell: Cell<any>,
): Record<
  string,
  {
    handler?: any;
    description: string;
    inputSchema?: JSONSchema;
    internal?: {
      kind: ToolKind;
      path: string[];
      pieceName: string;
      handle?: string;
    };
  }
> {
  const flattened: Record<string, any> = {};
  const { legacy } = collectToolEntries(toolsCell);

  for (const entry of legacy) {
    const passThrough: Record<string, unknown> = { ...entry.tool };
    if (
      passThrough.inputSchema && typeof passThrough.inputSchema === "object"
    ) {
      passThrough.inputSchema = stripInjectedResult(passThrough.inputSchema);
    }
    flattened[entry.name] = passThrough;
  }

  flattened[READ_TOOL_NAME] = {
    description:
      'Read data from any cell. Input: { "@link": "/of:bafyabc123/path" }. ' +
      "Returns the cell's data with nested cells as link objects. " +
      "Compose with invoke(): invoke() returns a link, then read(link) gets the data. ",
    inputSchema: READ_INPUT_SCHEMA,
  };
  flattened[INVOKE_TOOL_NAME] = {
    description:
      'Invoke a handler or pattern. If you do not know the schema of the the handler, use schema() first. Input: { "@link": "/of:bafyabc123/doThing" }, plus optional args. ' +
      'Returns { "@link": "/of:xyz/result" } pointing to the result cell. ',
    inputSchema: INVOKE_INPUT_SCHEMA,
  };
  flattened[PIN_TOOL_NAME] = {
    description:
      'Pin a cell for easy reference. Input: { "@link": "/of:bafyabc123" } and a name. ' +
      "Pinned cells and their values appear in the system prompt. " +
      "Use to track important cells you're working with.",
    inputSchema: PIN_INPUT_SCHEMA,
  };
  flattened[UNPIN_TOOL_NAME] = {
    description: 'Unpin a cell. Input: { "@link": "/of:bafyabc123" }. ' +
      "Use when you no longer need quick access to a cell.",
    inputSchema: UNPIN_INPUT_SCHEMA,
  };
  flattened[UPDATE_ARGUMENT_TOOL_NAME] = {
    description:
      'Update arguments of a running pattern instance. Input: { "@link": "/of:bafyabc123" } and updates object. ' +
      "The pattern will automatically re-execute with the new arguments. " +
      "Use after invoke() creates a pattern, or to modify attached pattern instances. " +
      'Example: updateArgument({ "@link": "/of:xyz" }, { "query": "new search" })',
    inputSchema: UPDATE_ARGUMENT_INPUT_SCHEMA,
  };
  flattened[SCHEMA_TOOL_NAME] = {
    description:
      "Get the JSON schema for a cell to understand its structure, fields, and handlers. " +
      'Input: { "@link": "/of:bafyabc123" }. ' +
      "Returns schema showing what data can be read and what handlers can be invoked. ",
    inputSchema: SCHEMA_INPUT_SCHEMA,
  };

  return flattened;
}

/**
 * Compare two flattened tool objects to detect changes.
 * Uses a heuristic approach that compares only serializable properties
 * (description, inputSchema, internal) and excludes handler which may have
 * circular references.
 */
function _toolsHaveChanged(
  newTools: Record<string, any>,
  oldTools: Record<string, any> | undefined,
): boolean {
  if (!oldTools) return true;

  const newKeys = Object.keys(newTools).sort();
  const oldKeys = Object.keys(oldTools).sort();

  // Check if the set of tools changed
  if (newKeys.length !== oldKeys.length) return true;
  if (newKeys.some((key, i) => key !== oldKeys[i])) return true;

  // Check if any tool's serializable properties changed
  for (const key of newKeys) {
    const newTool = newTools[key];
    const oldTool = oldTools[key];

    // Compare description
    if (newTool.description !== oldTool.description) return true;

    // Compare inputSchema (safe to stringify as it's a JSON Schema)
    try {
      const newSchema = JSON.stringify(newTool.inputSchema);
      const oldSchema = JSON.stringify(oldTool.inputSchema);
      if (newSchema !== oldSchema) return true;
    } catch {
      // If schema has circular refs (unlikely), consider it changed
      return true;
    }

    // Compare internal metadata
    try {
      const newInternal = JSON.stringify(newTool.internal);
      const oldInternal = JSON.stringify(oldTool.internal);
      if (newInternal !== oldInternal) return true;
    } catch {
      // If internal has circular refs (unlikely), consider it changed
      return true;
    }
  }

  return false;
}

function buildToolCatalog(
  toolsCell:
    | Cell<Record<string, Schema<typeof LLMToolSchema>>>
    | Cell<Record<string, BuiltInLLMTool> | undefined>,
): ToolCatalog {
  const { legacy } = collectToolEntries(
    toolsCell.asSchema(
      {
        type: "object",
        additionalProperties: LLMToolSchema,
      } as const as JSONSchema,
    ),
  );
  const llmTools: ToolCatalog["llmTools"] = {};
  const dynamicToolCells = new Map<
    string,
    Cell<Schema<typeof LLMToolSchema>>
  >();

  for (const entry of legacy) {
    const toolValue = entry.tool ?? {};
    const pattern = toolValue?.pattern?.get?.() ?? toolValue?.pattern;
    const handler = isCell(toolValue?.handler)
      ? toolValue.handler.resolveAsCell()
      : undefined;
    let inputSchema = pattern?.argumentSchema ?? handler?.schema ??
      toolValue?.inputSchema;
    if (inputSchema === undefined) {
      logger.warn("llm", `No input schema found for tool ${entry.name}`);
      continue;
    }
    inputSchema = normalizeInputSchema(inputSchema);
    const description: string = toolValue.description ??
      (inputSchema as any)?.description ?? "";
    llmTools[entry.name] = { description, inputSchema };
    dynamicToolCells.set(entry.name, entry.cell);
  }

  llmTools[READ_TOOL_NAME] = {
    description:
      'Read data from any cell. Input: { "@link": "/of:bafyabc123/path" }. ' +
      "Returns the cell's data with nested cells as link objects. " +
      "Compose with invoke(): invoke() returns a link, then read(link) gets the data. ",
    inputSchema: READ_INPUT_SCHEMA,
  };
  llmTools[INVOKE_TOOL_NAME] = {
    description:
      'Invoke a handler or pattern. Input: { "@link": "/of:bafyabc123/doThing" }, plus optional args. ' +
      'Returns { "@link": "/of:xyz/result" } pointing to the result cell. ',
    inputSchema: INVOKE_INPUT_SCHEMA,
  };
  llmTools[PIN_TOOL_NAME] = {
    description:
      'Pin a cell for easy reference. Input: { "@link": "/of:bafyabc123" } and a name. ' +
      "Pinned cells and their values appear in the system prompt. " +
      "Use to track important cells you're working with.",
    inputSchema: PIN_INPUT_SCHEMA,
  };
  llmTools[UNPIN_TOOL_NAME] = {
    description: 'Unpin a cell. Input: { "@link": "/of:bafyabc123" }. ' +
      "Use when you no longer need quick access to a cell.",
    inputSchema: UNPIN_INPUT_SCHEMA,
  };
  llmTools[UPDATE_ARGUMENT_TOOL_NAME] = {
    description:
      'Update arguments of a running pattern instance. Input: { "@link": "/of:bafyabc123" } and updates object. ' +
      "The pattern will automatically re-execute with the new arguments. " +
      "Use after invoke() creates a pattern, or to modify attached pattern instances. " +
      'Example: updateArgument({ "@link": "/of:xyz" }, { "query": "new search" })',
    inputSchema: UPDATE_ARGUMENT_INPUT_SCHEMA,
  };
  llmTools[SCHEMA_TOOL_NAME] = {
    description:
      "Get the JSON schema for a cell to understand its structure, fields, and handlers. " +
      'Input: { "@link": "/of:bafyabc123" }. ' +
      "Returns schema showing what data can be read and what handlers can be invoked. ",
    inputSchema: SCHEMA_INPUT_SCHEMA,
  };

  return { llmTools, dynamicToolCells };
}

/**
 * Build a formatted documentation string describing all available cells:
 * both context cells (passed via the context parameter) and pinned cells
 * (managed by pin/unpin tools). Includes schemas and current values for each cell.
 * This is appended to the system prompt so the LLM has immediate context.
 */
function buildAvailableCellsDocumentation(
  runtime: Runtime,
  space: MemorySpace,
  context: Record<string, Cell<any>> | undefined,
  pinnedCells: Cell<PinnedCell[]>,
): string {
  const entries: string[] = [];

  // First, process context cells (if provided)
  if (context) {
    for (const [name, cell] of Object.entries(context)) {
      try {
        const resolvedCell = cell.resolveAsCell();
        const link = resolvedCell.getAsNormalizedFullLink();
        const path = createLLMFriendlyLink(link, space);
        const schemaInfo = getCellSchema(resolvedCell);

        let entry = `## ${name} (${path})\n`;

        if (schemaInfo !== undefined) {
          const schemaStr = getSchemaTypeString(schemaInfo);

          entry += `- Schema: \`\`\`typescript\n${schemaStr}\n\`\`\`\n`;
        }

        try {
          const value = resolvedCell.get();
          const serialized = traverseAndSerialize(
            value,
            schemaInfo,
            new Set(),
            space,
          );

          let valueJson = JSON.stringify(serialized, null, 2);

          const MAX_VALUE_LENGTH = 2000;
          if (valueJson.length > MAX_VALUE_LENGTH) {
            valueJson = valueJson.substring(0, MAX_VALUE_LENGTH) +
              "\n... (truncated)";
          }

          entry += `- Current Value: \`\`\`json\n${valueJson}\n\`\`\`\n`;
        } catch (e) {
          logger.warn(
            "llm",
            `Failed to serialize value for context cell ${name}:`,
            e,
          );
          entry += `- Current Value: (unable to serialize)\n`;
        }

        entries.push(entry);
      } catch (e) {
        logger.warn("llm", `Failed to document context cell ${name}:`, e);
      }
    }
  }

  // Then, process pinned cells
  const currentPinnedCells = pinnedCells.get() || [];
  for (const pinnedCell of currentPinnedCells) {
    try {
      // Parse the path using the same parser as read/run tools
      const link = parseLLMFriendlyLink(pinnedCell.path, space);

      // Get cell from link
      const cell = runtime.getCellFromLink(link);
      if (!cell) {
        logger.warn(
          "llm",
          `Could not resolve pinned cell ${pinnedCell.path} to a cell`,
        );
        continue;
      }

      const resolvedCell = cell.resolveAsCell();

      // Get schema for the cell. Resolve picks up all schemas on links from it.
      const schemaInfo = getCellSchema(resolvedCell);

      // Build documentation entry with both schema and value
      let entry = `## ${pinnedCell.name} (${pinnedCell.path})\n`;

      // Add schema if available
      if (schemaInfo !== undefined) {
        const schemaStr = getSchemaTypeString(schemaInfo);
        entry += `- Schema: \`\`\`typescript\n${schemaStr}\n\`\`\`\n`;
      }

      // Add current value
      try {
        const value = resolvedCell.get();
        const serialized = traverseAndSerialize(
          value,
          schemaInfo,
          new Set(),
          space,
        );

        let valueJson = JSON.stringify(serialized, null, 2);

        // Truncate if too large
        const MAX_VALUE_LENGTH = 2000;
        if (valueJson.length > MAX_VALUE_LENGTH) {
          valueJson = valueJson.substring(0, MAX_VALUE_LENGTH) +
            "\n... (truncated)";
        }

        entry += `- Current Value: \`\`\`json\n${valueJson}\n\`\`\`\n`;
      } catch (e) {
        logger.warn(
          "llm",
          `Failed to serialize value for ${pinnedCell.name}:`,
          e,
        );
        entry += `- Current Value: (unable to serialize)\n`;
      }

      entries.push(entry);
    } catch (e) {
      logger.warn(
        "llm",
        `Failed to document pinned cell ${pinnedCell.name} (${pinnedCell.path}):`,
        e,
      );
    }
  }

  if (entries.length === 0) {
    return "";
  }

  return "\n\n# Available Cells\n\n" + entries.join("\n\n");
}

// Discriminated union separating external tools from built-in tools
type ResolvedToolCall =
  // Tools provided from outside (by the pattern calling llm-dialog)
  | {
    type: "external";
    call: LLMToolCall;
    toolDef: Cell<Schema<typeof LLMToolSchema>>;
  }
  // Built-in tools provided by llm-dialog itself
  | { type: "pin"; call: LLMToolCall; path: string; name: string }
  | { type: "unpin"; call: LLMToolCall; path: string }
  | { type: "schema"; call: LLMToolCall; cellRef: Cell<any> }
  | { type: "read"; call: LLMToolCall; cellRef: Cell<any> }
  | { type: "finalResult"; call: LLMToolCall; result: unknown }
  | {
    type: "updateArgument";
    call: LLMToolCall;
    cellRef: Cell<any>;
    updates: Record<string, unknown>;
  }
  | {
    type: "invoke";
    call: LLMToolCall;
    // Implementation details for how to invoke the target
    pattern?: Readonly<Recipe>;
    handler?: Stream<any>;
    extraParams?: Record<string, unknown>;
    piece?: Cell<any>;
  };

function resolveToolCall(
  runtime: Runtime,
  space: MemorySpace,
  toolCallPart: BuiltInLLMToolCallPart,
  catalog: ToolCatalog,
): ResolvedToolCall {
  const name = toolCallPart.toolName;
  const id = toolCallPart.toolCallId;
  const externalTool = catalog.dynamicToolCells.get(name);
  if (externalTool) {
    return {
      type: "external",
      toolDef: externalTool,
      call: { id, name, input: toolCallPart.input },
    };
  }

  if (
    name === READ_TOOL_NAME || name === INVOKE_TOOL_NAME ||
    name === SCHEMA_TOOL_NAME || name === PIN_TOOL_NAME ||
    name === UNPIN_TOOL_NAME || name === FINAL_RESULT_TOOL_NAME ||
    name === UPDATE_ARGUMENT_TOOL_NAME
  ) {
    // Handle pin
    if (name === PIN_TOOL_NAME) {
      const path = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      const pinnedCellName = extractStringField(
        toolCallPart.input,
        "name",
        "My Cell",
      );
      return {
        type: "pin",
        call: { id, name, input: { path, name: pinnedCellName } },
        path,
        name: pinnedCellName,
      };
    }

    // Handle unpin
    if (name === UNPIN_TOOL_NAME) {
      const path = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      return {
        type: "unpin",
        call: { id, name, input: { path } },
        path,
      };
    }

    // Handle finalResult (builtin tool for generateObject)
    if (name === FINAL_RESULT_TOOL_NAME) {
      return {
        type: "finalResult",
        call: { id, name, input: toolCallPart.input },
        result: toolCallPart.input,
      };
    }

    // Handle updateArgument
    if (name === UPDATE_ARGUMENT_TOOL_NAME) {
      const target = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      const link = parseLLMFriendlyLink(target, space);
      const cellRef = runtime.getCellFromLink(link);

      const updates = toolCallPart.input?.updates;
      if (!updates || typeof updates !== "object") {
        throw new Error(
          "updates must be an object with field names and values",
        );
      }

      return {
        type: "updateArgument",
        cellRef,
        call: { id, name, input: { path: target, updates } },
        updates: updates as Record<string, unknown>,
      };
    }

    const target = extractStringField(
      toolCallPart.input,
      "path",
      "/of:bafyabc123/path",
    );

    const link = parseLLMFriendlyLink(target, space);
    const cellRef = runtime.getCellFromLink(link);

    if (name === SCHEMA_TOOL_NAME) {
      const pieceName = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123/path",
      );
      return {
        type: "schema",
        cellRef,
        call: { id, name, input: { piece: pieceName } },
      };
    }

    if (name === READ_TOOL_NAME) {
      // Get cell reference from the link - works for any valid handle
      if (isStream(cellRef.resolveAsCell())) {
        throw new Error(`Path resolves to a handler; use invoke() instead.`);
      }

      return {
        type: "read",
        cellRef,
        call: { id, name, input: { path: target } },
      };
    }

    if (isStream(cellRef.resolveAsCell())) {
      return {
        type: "invoke",
        handler: cellRef as unknown as Stream<any>,
        call: {
          id,
          name,
          input: extractRunArguments(toolCallPart.input),
        },
      };
    }

    const pattern = cellRef.key("pattern")
      .getRaw() as unknown as Readonly<Recipe> | undefined;
    if (pattern) {
      return {
        type: "invoke",
        pattern,
        extraParams: cellRef.key("extraParams").get() ?? {},
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
  runtime: Runtime,
  space: MemorySpace,
  toolCatalog: ToolCatalog,
  toolCallParts: BuiltInLLMToolCallPart[],
  pinnedCells?: Cell<PinnedCell[]>,
): Promise<ToolCallExecutionResult[]> {
  const results: ToolCallExecutionResult[] = [];
  for (const part of toolCallParts) {
    try {
      const resolved = resolveToolCall(runtime, space, part, toolCatalog);
      const resultValue = await invokeToolCall(
        runtime,
        space,
        resolved,
        toolCatalog,
        pinnedCells,
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
  parseLLMFriendlyLink,
  traverseAndSerialize,
  traverseAndCellify,
  extractStringField,
  extractRunArguments,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
  FINAL_RESULT_TOOL_NAME,
  simplifySchemaForContext,
};

/**
 * Shared tool execution utilities for use by other LLM built-ins (llm, generateText).
 * These functions handle tool catalog building, tool call resolution, and execution.
 */
export const llmToolExecutionHelpers = {
  FINAL_RESULT_TOOL_NAME,
  buildToolCatalog,
  executeToolCalls,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
  buildAvailableCellsDocumentation,
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
  runtime: Runtime,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  action: (tx: IExtendedStorageTransaction) => void,
) {
  const { ok } = await runtime.editWithRetry((tx) => {
    if (
      pending.withTx(tx).get() &&
      internal.withTx(tx).key("requestId").get() === requestId
    ) {
      action(tx);
      internal.withTx(tx).key("lastActivity").set(Date.now());
      return true;
    } else {
      // We might have flagged success as true in a previous call, but if the
      // retry flow lands us here, it means it wasn't written and that now
      // the requestId has changed.
      return false;
    }
  });

  return !!ok;
}

/**
 * Handles the pin tool call.
 */
function handlePin(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "pin" },
  pinnedCells: Cell<PinnedCell[]>,
): { type: string; value: any } {
  const current = pinnedCells.get() || [];

  // Check if already pinned
  if (current.some((p) => p.path === resolved.path)) {
    return {
      type: "json",
      value: { success: false, message: "Already pinned" },
    };
  }

  // Add new pinned cell using a transaction
  runtime.editWithRetry((tx) => {
    const currentInTx = pinnedCells.withTx(tx).get() || [];
    pinnedCells.withTx(tx).set([
      ...currentInTx,
      { path: resolved.path, name: resolved.name },
    ]);
  });

  return { type: "json", value: { success: true } };
}

/**
 * Handles the unpin tool call.
 */
function handleUnpin(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "unpin" },
  pinnedCells: Cell<PinnedCell[]>,
): { type: string; value: any } {
  const current = pinnedCells.get() || [];
  const filtered = current.filter((p) => p.path !== resolved.path);

  if (filtered.length === current.length) {
    return {
      type: "json",
      value: { success: false, message: "Not found" },
    };
  }

  // Remove pinned cell using a transaction
  runtime.editWithRetry((tx) => {
    const currentInTx = pinnedCells.withTx(tx).get() || [];
    const filteredInTx = currentInTx.filter((p) => p.path !== resolved.path);
    pinnedCells.withTx(tx).set(filteredInTx);
  });

  return { type: "json", value: { success: true } };
}

/**
 * Handles the schema tool call.
 */
function handleSchema(
  resolved: ResolvedToolCall & { type: "schema" },
): { type: string; value: any } {
  const schema = getCellSchema(resolved.cellRef) ?? {};
  const value = JSON.parse(JSON.stringify(schema));
  return { type: "json", value };
}

/**
 * Handles the read tool call.
 */
function handleRead(
  resolved: ResolvedToolCall & { type: "read" },
  space: MemorySpace,
): { type: string; value: unknown } {
  let cell = resolved.cellRef;
  if (!cell.schema) {
    cell = cell.asSchema(getCellSchema(cell));
  }

  const schema = cell.schema;
  const serialized = traverseAndSerialize(
    cell.get(),
    schema,
    new Set(),
    space,
  );

  // Handle undefined by returning null (valid JSON) instead
  return {
    type: "json",
    value: serialized ?? null,
    ...(schema !== undefined && { schema }),
  };
}

/**
 * Handles the update Argument tool call.
 */
function handleUpdateArgument(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "updateArgument" },
): { type: string; value: any } {
  const cell = resolved.cellRef;
  const updates = resolved.updates;

  // Get the source cell (process cell) that stores the pattern metadata
  const sourceCell = cell.getSourceCell();
  if (!sourceCell) {
    throw new Error(
      "Target is not a pattern instance - no source cell found. " +
        "updateArgument only works with running patterns (e.g., from invoke() or attached patterns).",
    );
  }

  // Access the argument cell
  const argumentCell = sourceCell.key("argument");
  const cellifiedValue = traverseAndCellify(
    runtime,
    argumentCell.space,
    updates,
  );

  // Apply updates to argument fields
  runtime.editWithRetry((tx) => {
    if (isObject(cellifiedValue) && !isCell(cellifiedValue)) {
      argumentCell.withTx(tx).update(cellifiedValue);
    } else {
      argumentCell.withTx(tx).set(cellifiedValue);
    }
  });

  return {
    type: "json",
    value: {
      success: true,
      message: "Arguments updated. Pattern will re-execute automatically.",
    },
  };
}

/**
 * Handles the invoke tool call (both pattern and handler execution).
 */
async function handleInvoke(
  runtime: Runtime,
  space: MemorySpace,
  resolved: ResolvedToolCall,
): Promise<{ type: string; value: any }> {
  const toolCall = resolved.call;

  // Extract pattern/handler/params based on the resolved type
  let pattern: Readonly<Recipe> | undefined;
  let extraParams: Record<string, unknown> = {};
  let handler: any;

  if (resolved.type === "external") {
    pattern = resolved.toolDef.key("pattern").getRaw() as unknown as
      | Readonly<Recipe>
      | undefined;
    extraParams = resolved.toolDef.key("extraParams").get() ?? {};
    handler = resolved.toolDef.key("handler");
  } else if (resolved.type === "invoke") {
    pattern = resolved.pattern;
    extraParams = resolved.extraParams ?? {};
    handler = resolved.handler;
  }

  const input = traverseAndCellify(runtime, space, toolCall.input) as object;

  const { resolve, promise } = Promise.withResolvers<any>();

  // Create result cell reference that will be set in the transaction
  let result: Cell<any> = null as any;

  await runtime.editWithRetry((tx) => {
    // Create the result cell within the transaction context
    result = runtime.getCell<any>(
      space,
      toolCall.id,
      pattern ? pattern.resultSchema : undefined,
      tx,
    );

    if (pattern) {
      runtime.run(tx, pattern, { ...input, ...extraParams }, result);
    } else if (handler) {
      handler.withTx(tx).send({
        ...input,
        result, // doesn't HAVE to be used, but can be
      }, (completedTx: IExtendedStorageTransaction) => {
        const summary = formatTransactionSummary(completedTx, space);
        const value = result.withTx(completedTx);
        resolve({ value, summary });
      });
    } else {
      throw new Error("Tool has neither pattern nor handler");
    }
  });

  await runtime.idle();

  // Wait for the pattern/handler to complete and write the result
  const cancel = result.sink((r) => {
    r !== undefined && resolve(r);
  });

  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Tool call timed out"));
    }, TOOL_CALL_TIMEOUT);
  }).then(() => {
    throw new Error("Tool call timed out");
  });

  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
    cancel();
  }

  // Get the actual entity ID from the result cell
  const resultLink = createLLMFriendlyLink(
    result.getAsNormalizedFullLink(),
    space,
  );

  const resultSchema = getCellSchema(result);

  // Patterns always write to the result cell, so always return the link
  if (pattern) {
    return {
      type: "json",
      value: {
        "@resultLocation": resultLink,
        result: traverseAndSerialize(
          result.get(),
          resultSchema,
          new Set(),
          space,
        ),
        schema: resultSchema,
      },
    };
  }

  // Handlers may or may not write to the result cell
  // Only return a link if the handler actually wrote something
  if (handler) {
    const resultValue = result.get();

    if (resultValue !== undefined && resultValue !== null) {
      return {
        type: "json",
        value: {
          "@resultLocation": resultLink,
          result: traverseAndSerialize(
            resultValue,
            resultSchema,
            new Set(),
            space,
          ),
          schema: resultSchema,
        },
      };
    }
    // Handler didn't write anything, return null
    return { type: "json", value: null };
  }

  throw new Error("Tool has neither pattern nor handler");
}

/**
 * Executes a tool call by invoking its handler function and returning the
 * result. Creates a new transaction, sends the tool call arguments to the
 * handler, and waits for the result to be available before returning it.
 *
 * @param runtime - The runtime instance for creating transactions and cells
 * @param space - The memory space for the tool execution
 * @param resolved - The resolved tool call containing type and metadata
 * @param catalog - Optional tool catalog for lookups
 * @returns Promise that resolves to the tool execution result
 */
async function invokeToolCall(
  runtime: Runtime,
  space: MemorySpace,
  resolved: ResolvedToolCall,
  _catalog?: ToolCatalog,
  pinnedCells?: Cell<PinnedCell[]>,
) {
  // Handle pinned cell tools
  if (resolved.type === "pin") {
    return handlePin(runtime, resolved, pinnedCells!);
  }

  if (resolved.type === "unpin") {
    return handleUnpin(runtime, resolved, pinnedCells!);
  }

  if (resolved.type === "schema") {
    return handleSchema(resolved);
  }

  if (resolved.type === "read") {
    return handleRead(resolved, space);
  }

  if (resolved.type === "finalResult") {
    // Return the structured result directly
    return traverseAndCellify(runtime, space, resolved.result);
  }

  // Handle run-type tools (external, run with pattern/handler)
  if (resolved.type === "updateArgument") {
    return handleUpdateArgument(runtime, resolved);
  }

  // Handle invoke-type tools (external, invoke with pattern/handler)
  return await handleInvoke(runtime, space, resolved);
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
  runtime: Runtime, // Runtime will be injected by the registration function
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
  let pinnedCells: Cell<PinnedCell[]>;
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

      // Create pinnedCells cell to store the internal pinned cells state
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
      pinnedCells = runtime.getCell(
        parentCell.space,
        { llmDialog: { pinnedCells: cause } },
        pinnedCellsSchema,
        tx,
      );
      pinnedCells.sync(); // Kick off sync, no need to await

      const pending = result.key("pending");

      // Write the stream markers and initialize pinnedCells as empty array.
      // This write might fail (since the original data wasn't loaded yet), but
      // that's ok, since in that case another instance already wrote these.
      //
      // We are carrying the existing pending state over, in case the result
      // cell was already loaded. We don't want to overwrite it.
      result.setRaw({
        ...result.getRaw(),
        addMessage: { $stream: true },
        cancelGeneration: { $stream: true },
        pinnedCells: [],
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
            runtime,
            parentCell.space,
            cause,
            inputs,
            pending,
            internal,
            pinnedCells,
            result,
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
    // `flattenedTools` is for now just used in the UI, and so we only need
    // inputSchema and description. This makes retrieving the tools much faster.
    const toolsCell = inputs.key("tools").asSchema(
      {
        type: "object",
        additionalProperties: LLMReducedToolSchema,
      } as const satisfies JSONSchema,
    ).withTx(tx);
    const flattened = flattenTools(toolsCell);

    // Runtime already makes this a no-op if there are no changes
    result.withTx(tx).key("flattenedTools").set(flattened);

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
  runtime: Runtime,
  space: MemorySpace,
  cause: any,
  inputs: Cell<Schema<typeof LLMParamsSchema>>,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  pinnedCells: Cell<PinnedCell[]>,
  result: Cell<Schema<typeof resultSchema>>,
  requestId: string,
  abortSignal: AbortSignal,
) {
  // Pull input dependencies to ensure they're computed in pull mode
  await inputs.pull();
  await pinnedCells.pull();

  // Also pull individual context cells and pinned cell targets
  const contextCellsForPull = inputs.key("context").get() ?? {};
  for (const cell of Object.values(contextCellsForPull)) {
    if (isCell(cell)) {
      await cell.resolveAsCell().pull();
    }
  }
  const pinnedCellsForPull = pinnedCells.get() ?? [];
  for (const pinnedCell of pinnedCellsForPull) {
    try {
      const link = parseLLMFriendlyLink(pinnedCell.path, space);
      const cell = runtime.getCellFromLink(link);
      if (cell) {
        await cell.resolveAsCell().pull();
      }
    } catch {
      // Ignore errors - cell might not exist
    }
  }

  const { system, maxTokens, model } = inputs.get();

  const messagesCell = inputs.key("messages");
  const toolsCell = inputs.key("tools") as Cell<
    Record<string, Schema<typeof LLMToolSchema>>
  >;

  // Update merged pinnedCells in case context or internal pinnedCells changed
  const contextCells = inputs.key("context").get() ?? {};
  const toolPinnedCells = pinnedCells.get() ?? [];

  const contextAsPinnedCells: PinnedCell[] = Object.entries(contextCells)
    // Convert context cells to PinnedCell format
    .map(
      ([name, cell]) => {
        const link = cell.resolveAsCell().getAsNormalizedFullLink();
        const path = createLLMFriendlyLink(link, space);
        return { name, path };
      },
    )
    // Remove pinned cells that are already in the context
    .filter(({ path }) => !toolPinnedCells.some((cell) => cell.path === path));

  // Merge context cells and tool-pinned cells
  const mergedPinnedCells = [...contextAsPinnedCells, ...toolPinnedCells];

  // Write to result cell using editWithRetry since we're outside handler tx
  await runtime.editWithRetry((tx) => {
    result.withTx(tx).key("pinnedCells").set(mergedPinnedCells as any);
  });

  const toolCatalog = buildToolCatalog(toolsCell);

  // Build available cells documentation (both context and pinned cells)
  const context = inputs.key("context").get();
  const cellsDocs = buildAvailableCellsDocumentation(
    runtime,
    space,
    context,
    pinnedCells,
  );

  const linkModelDocs = `

# Link and Cell Model

The system organizes all data and computation into **cells**:

- **Data cells**: Contain JSON data that can be read and written
- **Handler cells (streams)**: Executable functions that can be invoked but not read directly
- **Pattern cells**: Running program instances that may contain both data fields and handler fields

## Links

Links are universal identifiers that point to cells. They use the format:

\`\`\`json
{ "@link": "/of:bafyabc123/path/to/cell" }
\`\`\`

Where:
- \`of:bafyabc123\` is the handle/ID of the root entity (piece, pattern instance, etc.)
- \`/path/to/cell\` is the path within that entity to a specific cell

## Tool Composition

Tools work together by passing links between them:

1. \`invoke({ "@link": "/of:abc/handler" }, args)\` → Returns \`{ "@link": "/of:xyz/result" }\`
2. \`read({ "@link": "/of:xyz/result" })\` → Returns the data, which may contain nested links
3. \`updateArgument({ "@link": "/of:pattern" }, { field: value })\` → Updates running pattern arguments
4. Data often contains links to other cells: \`{ items: [{ "@link": "/of:123" }, { "@link": "/of:456" }] }\`

## Pages

Some operations (especially \`invoke()\` with patterns) create "Pages" - running pattern instances that:
- Have their own identity accessible via a link
- Contain data fields that can be read with \`read()\`
- Contain handler fields that can be invoked with \`invoke()\`
- Arguments can be updated with \`updateArgument()\` to change pattern behavior dynamically
- May link to other cells in the system

**Use links to navigate between related data and compose operations.**`;

  const listRecentHint =
    "\n\nIf the user's request is unclear or you need context about what they're referring to, " +
    "call listRecent() to see recently viewed pieces.";

  const augmentedSystem = (system ?? "") + linkModelDocs + cellsDocs +
    listRecentHint;

  const llmParams: LLMRequest = {
    system: augmentedSystem,
    messages: messagesCell.get() as readonly BuiltInLLMMessage[],
    maxTokens: maxTokens,
    stream: true,
    model: model ?? DEFAULT_MODEL_NAME,
    metadata: { context: "piece" },
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
        logger.warn(
          "llm",
          "LLM returned invalid/empty content, adding error message",
        );
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

          // Add ID to assistant message and publish immediately
          (assistantMessage as BuiltInLLMMessage & { [ID]: unknown })[ID] = {
            llmDialog: { message: cause, id: crypto.randomUUID() },
          };

          await safelyPerformUpdate(
            runtime,
            pending,
            internal,
            requestId,
            (tx) => {
              messagesCell.withTx(tx).push(
                assistantMessage as Schema<typeof LLMMessageSchema>,
              );
            },
          );

          // Now execute the tool calls
          const toolResults = await executeToolCalls(
            runtime,
            space,
            toolCatalog,
            toolCallParts,
            pinnedCells,
          );

          // Validate that we have a result for every tool call with matching IDs
          const toolCallIds = new Set(toolCallParts.map((p) => p.toolCallId));
          const resultIds = new Set(toolResults.map((r) => r.id));
          const mismatch = toolResults.length !== toolCallParts.length ||
            !toolCallParts.every((p) => resultIds.has(p.toolCallId));

          if (mismatch) {
            logger.error(
              "llm-error",
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

          // Create and publish tool result messages
          const toolResultMessages = createToolResultMessages(toolResults);

          toolResultMessages.forEach((message) => {
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
                ...(toolResultMessages as Schema<typeof LLMMessageSchema>[]),
              );
            },
          );

          if (success) {
            logger.info("llm", "Continuing conversation after tool calls...");

            startRequest(
              runtime,
              space,
              cause,
              inputs,
              pending,
              internal,
              pinnedCells,
              result,
              requestId,
              abortSignal,
            );
          } else {
            logger.info(
              "llm",
              "Skipping write: pending=false or request changed",
            );
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

function getSchemaTypeString(schema: JSONSchema): string {
  let defs;
  if (isObject(schema)) {
    // Convert schema to TypeScript-like string for readability
    defs = (schema as Record<string, unknown>).$defs as
      | Record<string, JSONSchema>
      | undefined;
  }
  let schemaStr = schemaToTypeString(schema, { defs });
  const MAX_SCHEMA_LENGTH = 1000;
  if (schemaStr.length > MAX_SCHEMA_LENGTH) {
    schemaStr = schemaStr.substring(0, MAX_SCHEMA_LENGTH) +
      "\n  // ... truncated";
  }
  return schemaStr;
}

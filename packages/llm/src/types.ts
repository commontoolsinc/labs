import { isRecord } from "@commonfabric/utils/types";
import type { JSONValue } from "@commonfabric/api";
import { isPureJson } from "@commonfabric/pure-json";
import { LlmPrompt } from "./prompts/prompting.ts";
import type {
  BuiltInLLMContent,
  BuiltInLLMMessage,
  JSONSchema,
} from "@commonfabric/api";

// Resolved by the toolshed at startup: prefers gateway:claude-sonnet-4-6 when
// available, falls back to anthropic:claude-sonnet-4-5 otherwise. See
// `registerDefaultModel` in packages/toolshed/routes/ai/llm/models.ts.
export const DEFAULT_MODEL_NAME: ModelName = "default";

// NOTE(ja): This should be an array of models, the first model will be tried, if it
// fails, the second model will be tried, etc.
export const DEFAULT_IFRAME_MODELS: ModelName = "openai:gpt-5-mini";
export const DEFAULT_GENERATE_OBJECT_MODELS: ModelName = "openai:gpt-5-mini";

export type LLMResponse = BuiltInLLMMessage & {
  // The trace span ID
  id: string;
  nativeModelToolResults?: readonly LLMNativeModelToolResult[];
};

export type ModelName = string;
export type LLMPrompt = LlmPrompt;
// Use BuiltIn types directly
export type LLMContent = BuiltInLLMContent;

export type LLMTool = {
  description: string;
  inputSchema: JSONSchema;
};

export const GOOGLE_SEARCH_NATIVE_MODEL_TOOL = "google_search" as const;
export const LLM_NATIVE_MODEL_TOOL_IDS = [
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
] as const;

export type LLMNativeModelToolId = typeof LLM_NATIVE_MODEL_TOOL_IDS[number];

export type LLMNativeModelToolResult = {
  type: "cf-harness.native-model-tool-result";
  toolId: LLMNativeModelToolId;
  provider?: string;
  providerMetadata?: unknown;
  sources?: unknown;
};

export function isLLMNativeModelToolId(
  input: unknown,
): input is LLMNativeModelToolId {
  return typeof input === "string" &&
    (LLM_NATIVE_MODEL_TOOL_IDS as readonly string[]).includes(input);
}

export function isLLMNativeModelToolResult(
  input: unknown,
): input is LLMNativeModelToolResult {
  return isRecord(input) && !Array.isArray(input) &&
    input.type === "cf-harness.native-model-tool-result" &&
    isLLMNativeModelToolId(input.toolId) &&
    (!("provider" in input) || typeof input.provider === "string");
}

export function isLLMNativeModelToolResults(
  input: unknown,
): input is LLMNativeModelToolResult[] {
  return Array.isArray(input) && input.every(isLLMNativeModelToolResult);
}

export type LLMToolCall = {
  id: string;
  name: string;
  input: Record<string, any>;
};

export type LLMToolResult = {
  toolCallId: string;
  result: any;
  error?: string;
};

/**
 * Request metadata. This crosses a JSON boundary to a general LLM API, so
 * values must be values ordinary JSON serialization carries faithfully -- not
 * merely `FabricValue`s, which admit `bigint`, interned symbols, `NaN` / `-0`,
 * and fabric primitives that no model API can receive.
 *
 * `isLLMRequestMetadata()` is the authority: it checks with `isPureJson()`. An `undefined` value means "absent" -- JSON
 * drops such a key, so it never crosses the boundary and is not checked.
 */
export type LLMRequestMetadata = Record<string, JSONValue | undefined>;
export type LLMRequest = {
  cache?: boolean;
  messages: readonly BuiltInLLMMessage[];
  model: ModelName;
  system?: string;
  maxTokens?: number;
  stream?: boolean;
  stop?: string;
  mode?: "json";
  metadata?: LLMRequestMetadata;
  tools?: Record<string, LLMTool>;
  nativeModelToolIds?: readonly LLMNativeModelToolId[];
};

export type LLMGenerateObjectRequest = {
  schema: Record<string, unknown>;
  messages: readonly BuiltInLLMMessage[];
  model?: ModelName;
  system?: string;
  cache?: boolean;
  maxTokens?: number;
  metadata?: LLMRequestMetadata;
};

export type LLMGenerateObjectResponse = {
  object: Record<string, unknown>;
  id?: string;
};

function isArrayOf<T>(
  callback: (data: unknown) => boolean,
  input: unknown,
): input is T[] {
  return Array.isArray(input) &&
    input.map((value) => callback(value)).every(Boolean);
}

export function isLLMRequestMetadata(
  input: unknown,
): input is LLMRequestMetadata {
  if (!isRecord(input) || Array.isArray(input)) return false;
  // An `undefined` value means "absent": JSON drops the key, so it is not part
  // of what crosses the boundary and does not have to be pure JSON.
  const present = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  return isPureJson(present);
}

// Validator functions removed - use BuiltInLLM types directly

export function isLLMContent(input: unknown): input is LLMContent {
  return typeof input === "string" || (Array.isArray(input) && input.every(
    (item) =>
      isRecord(item) &&
      (item.type === "text" || item.type === "image" ||
        item.type === "tool-call" || item.type === "tool-result"),
  ));
}

export function isLLMToolCall(input: unknown): input is LLMToolCall {
  return isRecord(input) && !Array.isArray(input) &&
    typeof input.id === "string" &&
    typeof input.name === "string" &&
    isRecord(input.arguments);
}

export function isLLMToolResult(input: unknown): input is LLMToolResult {
  return isRecord(input) && !Array.isArray(input) &&
    typeof input.toolCallId === "string" &&
    (!("error" in input) || typeof input.error === "string");
}

export function isLLMTool(input: unknown): input is LLMTool {
  return isRecord(input) && !Array.isArray(input) &&
    typeof input.description === "string" &&
    isRecord(input.inputSchema) &&
    (!("handler" in input) || typeof input.handler === "function");
}

export function isLLMMessage(input: unknown): input is BuiltInLLMMessage {
  return isRecord(input) && !Array.isArray(input) &&
    (input.role === "user" || input.role === "assistant" ||
      input.role === "tool") &&
    isLLMContent(input.content) &&
    (!("toolCalls" in input) || (Array.isArray(input.toolCalls) &&
      input.toolCalls.every((tc: unknown) => isLLMToolCall(tc)))) &&
    (!("toolCallId" in input) || typeof input.toolCallId === "string");
}

export const isLLMMessages = (isArrayOf<BuiltInLLMMessage>).bind(
  null,
  isLLMMessage,
);

/**
 * Extract text content from LLMResponse, handling both string and content parts array
 */
export function extractTextFromLLMResponse(response: LLMResponse): string {
  if (typeof response.content === "string") {
    return response.content;
  }

  if (Array.isArray(response.content)) {
    // Extract text from all text parts and join them
    return response.content
      .filter((part) => part.type === "text")
      .map((part) => (part as any).text)
      .join(" ");
  }

  return "";
}

export function isLLMRequest(input: unknown): input is LLMRequest {
  return isRecord(input) && !Array.isArray(input) &&
    typeof input.model === "string" && isLLMMessages(input.messages) &&
    ("cache" in input) &&
    (!("system" in input) || typeof input.system === "string") &&
    (!("maxTokens" in input) || typeof input.maxTokens === "number") &&
    (!("stream" in input) || typeof input.stream === "boolean") &&
    (!("stop" in input) || typeof input.stop === "string") &&
    (!("mode" in input) || input.mode === "json") &&
    (!("metadata" in input) || isLLMRequestMetadata(input.metadata)) &&
    (!("tools" in input) || (isRecord(input.tools) &&
      Object.values(input.tools).every((tool: unknown) => isLLMTool(tool)))) &&
    (!("nativeModelToolIds" in input) ||
      (Array.isArray(input.nativeModelToolIds) &&
        input.nativeModelToolIds.every(isLLMNativeModelToolId)));
}

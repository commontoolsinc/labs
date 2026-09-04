import type {
  BuiltInLLMContent,
  BuiltInLLMMessage,
  JSONSchema,
  JSONValue,
} from "@commonfabric/api";
import { isPureJson } from "@commonfabric/pure-json";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * The alias a request names to get whichever model the deployment considers
 * its default. The toolshed picks that model as it starts up, by walking
 * `DEFAULT_MODEL_CANDIDATES` in `packages/toolshed/routes/ai/llm/models.ts`
 * and taking the first candidate a provider registered.
 *
 * Which models exist is decided there and not here. `README.md` in this
 * package says why, and `docs/features/llm-provider-boundary.md` describes the
 * boundary in full.
 */
export const DEFAULT_MODEL_NAME: ModelName = "default";

// NOTE(ja): This should be an array of models, the first model will be tried, if it
// fails, the second model will be tried, etc.
export const DEFAULT_GENERATE_OBJECT_MODELS: ModelName = "openai:gpt-5-mini";

export type LLMResponse = BuiltInLLMMessage & {
  // The trace span ID
  id: string;
  nativeModelToolResults?: readonly LLMNativeModelToolResult[];
};

export type ModelName = string;
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
  return isObjectNotArray(input) &&
    input.type === "cf-harness.native-model-tool-result" &&
    isLLMNativeModelToolId(input.toolId) &&
    (!("provider" in input) || typeof input.provider === "string");
}

export function isLLMNativeModelToolResults(
  input: unknown,
): input is LLMNativeModelToolResult[] {
  return Array.isArray(input) && input.every(isLLMNativeModelToolResult);
}

/**
 * A tool call in its compact form: an identifier, the name of the tool, and
 * the input to call it with. This is not the shape a tool call has in a
 * message. There it is a `BuiltInLLMToolCallPart` within the content, naming
 * those same three things `toolCallId`, `toolName`, and `input`.
 */
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
 * and `FabricPrimitive`s that no model API can receive.
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
  schema: JSONSchema;
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
  if (!isObjectNotArray(input)) return false;
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
      isObjectNotArray(item) &&
      (item.type === "text" || item.type === "image" ||
        item.type === "tool-call" || item.type === "tool-result"),
  ));
}

export function isLLMToolResult(input: unknown): input is LLMToolResult {
  return isObjectNotArray(input) &&
    typeof input.toolCallId === "string" &&
    (!("error" in input) || typeof input.error === "string");
}

export function isLLMTool(input: unknown): input is LLMTool {
  return isObjectNotArray(input) &&
    typeof input.description === "string" &&
    isObjectNotArray(input.inputSchema) &&
    (!("handler" in input) || typeof input.handler === "function");
}

export function isLLMMessage(input: unknown): input is BuiltInLLMMessage {
  return isObjectNotArray(input) &&
    (input.role === "user" || input.role === "assistant" ||
      input.role === "tool") &&
    isLLMContent(input.content) &&
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
  return isObjectNotArray(input) &&
    typeof input.model === "string" && isLLMMessages(input.messages) &&
    ("cache" in input) &&
    (!("system" in input) || typeof input.system === "string") &&
    (!("maxTokens" in input) || typeof input.maxTokens === "number") &&
    (!("stream" in input) || typeof input.stream === "boolean") &&
    (!("stop" in input) || typeof input.stop === "string") &&
    (!("mode" in input) || input.mode === "json") &&
    (!("metadata" in input) || isLLMRequestMetadata(input.metadata)) &&
    (!("tools" in input) || (isObjectNotArray(input.tools) &&
      Object.values(input.tools).every((tool: unknown) => isLLMTool(tool)))) &&
    (!("nativeModelToolIds" in input) ||
      (Array.isArray(input.nativeModelToolIds) &&
        input.nativeModelToolIds.every(isLLMNativeModelToolId)));
}

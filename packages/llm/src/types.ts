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

export function isLLMTool(input: unknown): input is LLMTool {
  return isObjectNotArray(input) &&
    typeof input.description === "string" &&
    isObjectNotArray(input.inputSchema) &&
    (!("handler" in input) || typeof input.handler === "function");
}

/**
 * Names what stops `input` from being a `BuiltInLLMMessage`, or `undefined`
 * when nothing does. The text continues a sentence that names the message, as
 * in `Message 0 must be an object.`
 */
function llmMessageProblem(input: unknown): string | undefined {
  if (!isObjectNotArray(input)) return "must be an object";
  const { role } = input;
  if (role === "system") {
    return "carries the 'system' role, which belongs in the request's " +
      "'system' field rather than among its messages";
  }
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    return `must carry the role 'user', 'assistant', or 'tool', not ${
      JSON.stringify(role)
    }`;
  }
  if (!isLLMContent(input.content)) {
    return "must carry content that is either a string or an array of text, " +
      "image, tool-call, and tool-result parts";
  }
  return undefined;
}

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

/**
 * Names what stops `input` from being an `LLMRequest`, or `undefined` when
 * nothing does. A route that refuses a request returns this text, so its
 * caller learns which part of the payload to change.
 */
export function llmRequestProblem(input: unknown): string | undefined {
  if (!isObjectNotArray(input)) return "The request must be an object.";
  if (typeof input.model !== "string") return "'model' must be a string.";
  if (!Array.isArray(input.messages)) return "'messages' must be an array.";
  // The model provider refuses an empty conversation, `system` field or no,
  // so a request carrying one is the caller's to fix rather than the
  // provider's to report.
  if (input.messages.length === 0) return "'messages' must not be empty.";
  for (const [index, message] of input.messages.entries()) {
    const problem = llmMessageProblem(message);
    if (problem !== undefined) return `Message ${index} ${problem}.`;
  }
  if (!("cache" in input)) return "'cache' must be present.";
  if ("system" in input && typeof input.system !== "string") {
    return "'system' must be a string.";
  }
  if ("maxTokens" in input && typeof input.maxTokens !== "number") {
    return "'maxTokens' must be a number.";
  }
  if ("stream" in input && typeof input.stream !== "boolean") {
    return "'stream' must be a boolean.";
  }
  if ("stop" in input && typeof input.stop !== "string") {
    return "'stop' must be a string.";
  }
  if ("mode" in input && input.mode !== "json") {
    return "'mode' must be 'json'.";
  }
  if ("metadata" in input && !isLLMRequestMetadata(input.metadata)) {
    return "'metadata' must be an object whose values ordinary JSON " +
      "serialization carries faithfully.";
  }
  if (
    "tools" in input &&
    !(isObjectNotArray(input.tools) &&
      Object.values(input.tools).every(isLLMTool))
  ) {
    return "'tools' must be an object naming tools, each with a " +
      "'description' string and an 'inputSchema' object.";
  }
  if (
    "nativeModelToolIds" in input &&
    !(Array.isArray(input.nativeModelToolIds) &&
      input.nativeModelToolIds.every(isLLMNativeModelToolId))
  ) {
    return `'nativeModelToolIds' must be an array drawn from ${
      LLM_NATIVE_MODEL_TOOL_IDS.join(", ")
    }.`;
  }
  return undefined;
}

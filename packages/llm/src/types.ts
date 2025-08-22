import { isObject, isRecord } from "@commontools/utils/types";
import { LlmPrompt } from "./prompts/prompting.ts";

export const DEFAULT_MODEL_NAME: ModelName =
  "anthropic:claude-3-7-sonnet-latest";

// NOTE(ja): This should be an array of models, the first model will be tried, if it
// fails, the second model will be tried, etc.
export const DEFAULT_IFRAME_MODELS: ModelName = "openai:gpt-4.1-nano";
export const DEFAULT_GENERATE_OBJECT_MODELS: ModelName = "openai:gpt-4.1-nano";

export type LLMResponse = {
  content: string;
  // The trace span ID
  id: string;
};

export type ModelName = string;
export type LLMPrompt = LlmPrompt;
export interface LLMTypedContent {
  type: "text" | "image";
  data: string;
}
export type LLMContent = string | LLMTypedContent[];
export type LLMMessage = {
  role: "user" | "assistant";
  content: LLMContent;
};
export type LLMRequestMetadata = Record<string, string | undefined | object>;
export interface LLMRequest {
  cache?: boolean;
  messages: LLMMessage[];
  model: ModelName;
  system?: string;
  maxTokens?: number;
  stream?: boolean;
  stop?: string;
  mode?: "json";
  metadata?: LLMRequestMetadata;
}

export interface LLMGenerateObjectRequest {
  schema: Record<string, unknown>;
  prompt: string;
  model?: ModelName;
  system?: string;
  cache?: boolean;
  maxTokens?: number;
  metadata?: LLMRequestMetadata;
}

export interface LLMGenerateObjectResponse {
  object: Record<string, unknown>;
  id?: string;
}

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
  return isRecord(input) && !Array.isArray(input) &&
    Object.entries(input).every(([k, v]) =>
      typeof k === "string" &&
      (v === undefined || typeof v === "string" || typeof v === "object")
    );
}

export function isLLMTypedContent(input: unknown): input is LLMTypedContent {
  return isRecord(input) && !Array.isArray(input) &&
    (input.type === "text" || input.type === "image") &&
    typeof input.data === "string";
}

export function isLLMContent(input: unknown): input is LLMContent {
  return typeof input === "string"
    ? true
    : isArrayOf<LLMTypedContent>(isLLMTypedContent, input);
}

export function isLLMMessage(input: unknown): input is LLMMessage {
  return isRecord(input) && !Array.isArray(input) &&
    (input.role === "user" || input.role === "assistant") &&
    isLLMContent(input.content);
}

export const isLLMMessages = (isArrayOf<LLMMessage>).bind(null, isLLMMessage);

export function isLLMRequest(input: unknown): input is LLMRequest {
  return isRecord(input) && !Array.isArray(input) &&
    typeof input.model === "string" && isLLMMessages(input.messages) &&
    ("cache" in input) &&
    (!("system" in input) || typeof input.system === "string") &&
    (!("maxTokens" in input) || typeof input.maxTokens === "number") &&
    (!("stream" in input) || typeof input.stream === "boolean") &&
    (!("stop" in input) || typeof input.stop === "string") &&
    (!("mode" in input) || input.mode === "json") &&
    (!("metadata" in input) || isLLMRequestMetadata(input.metadata));
}

import { LlmPrompt } from "./prompts/prompting.ts";

export const DEFAULT_MODEL_NAME: ModelName =
  "anthropic:claude-3-7-sonnet-latest";
export const DEFAULT_FAST_MODEL_NAME: ModelName =
  "google:gemini-2.0-flash";

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
  cache: boolean;
  messages: LLMMessage[];
  model: ModelName;
  system?: string;
  maxTokens?: number;
  stream?: boolean;
  stop?: string;
  mode?: "json";
  metadata?: LLMRequestMetadata;
}

function isArrayOf<T>(
  callback: (data: any) => boolean,
  input: any,
): input is T[] {
  return Array.isArray(input) &&
    input.map((value) => callback(value)).every(Boolean);
}

export function isLLMRequestMetadata(input: any): input is LLMRequestMetadata {
  return input && typeof input === "object" &&
    Object.entries(input).every(([k, v]) =>
      typeof k === "string" &&
      (v === undefined || typeof v === "string" || typeof v === "object")
    );
}

export function isLLMTypedContent(input: any): input is LLMTypedContent {
  return input && typeof input === "object" &&
    (input.type === "text" || input.type === "image") &&
    typeof input.data === "string";
}

export function isLLMContent(input: any): input is LLMContent {
  return typeof input === "string"
    ? true
    : isArrayOf<LLMTypedContent>(isLLMTypedContent, input);
}

export function isLLMMessage(input: any): input is LLMMessage {
  return input && (input.role === "user" || input.role === "assistant") &&
    isLLMContent(input.content);
}

export const isLLMMessages = (isArrayOf<LLMMessage>).bind(null, isLLMMessage);

export function isLLMRequest(input: any): input is LLMRequest {
  return input && typeof input === "object" &&
    typeof input.model === "string" && isLLMMessages(input.messages) &&
    ("cache" in input) &&
    (!("system" in input) || typeof input.system === "string") &&
    (!("maxTokens" in input) || typeof input.maxTokens === "number") &&
    (!("stream" in input) || typeof input.stream === "boolean") &&
    (!("stop" in input) || typeof input.stop === "string") &&
    (!("mode" in input) || input.mode === "json") &&
    (!("metadata" in input) || isLLMRequestMetadata(input.metadata));
}

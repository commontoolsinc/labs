import { isObject, isRecord } from "@commontools/utils/types";
import { LlmPrompt } from "./prompts/prompting.ts";
import type {
  BuiltInLLMContent,
  BuiltInLLMContentPart,
  BuiltInLLMMessage,
  JSONSchema,
} from "@commontools/api";

export const DEFAULT_MODEL_NAME: ModelName =
  "anthropic:claude-3-7-sonnet-latest";

// NOTE(ja): This should be an array of models, the first model will be tried, if it
// fails, the second model will be tried, etc.
export const DEFAULT_IFRAME_MODELS: ModelName = "openai:gpt-4.1-nano";
export const DEFAULT_GENERATE_OBJECT_MODELS: ModelName = "openai:gpt-4.1-nano";

export type LLMResponse = BuiltInLLMMessage & {
  // The trace span ID
  id: string;
};

export type ModelName = string;
export type LLMPrompt = LlmPrompt;
// Use BuiltIn types directly
export type LLMContent = BuiltInLLMContent;

export interface LLMTool {
  description: string;
  inputSchema: JSONSchema;
  handler?: (args: any) => any | Promise<any>; // Client-side only
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface LLMToolResult {
  toolCallId: string;
  result: any;
  error?: string;
}

export type LLMRequestMetadata = Record<string, string | undefined | object>;
export interface LLMRequest {
  cache?: boolean;
  messages: BuiltInLLMMessage[];
  model: ModelName;
  system?: string;
  maxTokens?: number;
  stream?: boolean;
  stop?: string;
  mode?: "json";
  metadata?: LLMRequestMetadata;
  tools?: Record<string, LLMTool>;
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

// Validator functions removed - use BuiltInLLM types directly

export function isLLMContent(input: unknown): input is LLMContent {
  return typeof input === "string" || (Array.isArray(input) && input.every(
    item => isRecord(item) && 
      (item.type === "text" || item.type === "image" || item.type === "tool-call" || item.type === "tool-result")
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

export const isLLMMessages = (isArrayOf<BuiltInLLMMessage>).bind(null, isLLMMessage);

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
      .filter(part => part.type === "text")
      .map(part => (part as any).text)
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
      Object.values(input.tools).every((tool: unknown) => isLLMTool(tool))));
}

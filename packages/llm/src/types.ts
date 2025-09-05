import { isObject, isRecord } from "@commontools/utils/types";
import { LlmPrompt } from "./prompts/prompting.ts";
import type { JSONSchema } from "@commontools/api";

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
  // Tool calls made during generation
  toolCalls?: LLMToolCall[];
  // Results of completed tool calls
  toolResults?: LLMToolResult[];
};

export type ModelName = string;
export type LLMPrompt = LlmPrompt;
export interface LLMTypedContent {
  type: "text" | "image";
  data: string;
}

// New content part types matching Vercel AI SDK
export interface LLMTextPart {
  type: 'text';
  text: string;
}

export interface LLMToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
}

export interface LLMToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: any;
  error?: string;
}

// Update message content to support arrays with new part types
export type LLMContent = 
  | string 
  | Array<LLMTextPart | LLMToolCallPart | LLMToolResultPart | LLMTypedContent>;

export interface LLMTool {
  description: string;
  inputSchema: JSONSchema;
  handler?: (args: any) => any | Promise<any>; // Client-side only
}

// Legacy interfaces - kept for backward compatibility during migration
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

export type LLMMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: LLMContent;
  // Deprecated - will be removed after migration
  toolCalls?: LLMToolCall[];
  toolCallId?: string; // for tool result messages
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

export function isLLMTypedContent(input: unknown): input is LLMTypedContent {
  return isRecord(input) && !Array.isArray(input) &&
    (input.type === "text" || input.type === "image") &&
    typeof input.data === "string";
}

export function isLLMTextPart(input: unknown): input is LLMTextPart {
  return isRecord(input) && !Array.isArray(input) &&
    input.type === "text" &&
    typeof input.text === "string";
}

export function isLLMToolCallPart(input: unknown): input is LLMToolCallPart {
  return isRecord(input) && !Array.isArray(input) &&
    input.type === "tool-call" &&
    typeof input.toolCallId === "string" &&
    typeof input.toolName === "string" &&
    isRecord(input.args);
}

export function isLLMToolResultPart(input: unknown): input is LLMToolResultPart {
  return isRecord(input) && !Array.isArray(input) &&
    input.type === "tool-result" &&
    typeof input.toolCallId === "string" &&
    typeof input.toolName === "string" &&
    (!(("error" in input) || typeof input.error === "string"));
}

export function isLLMContentPart(input: unknown): boolean {
  return isLLMTypedContent(input) || isLLMTextPart(input) || 
    isLLMToolCallPart(input) || isLLMToolResultPart(input);
}

export function isLLMContent(input: unknown): input is LLMContent {
  return typeof input === "string"
    ? true
    : Array.isArray(input) && input.every(isLLMContentPart);
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

export function isLLMMessage(input: unknown): input is LLMMessage {
  return isRecord(input) && !Array.isArray(input) &&
    (input.role === "user" || input.role === "assistant" ||
      input.role === "tool" || input.role === "system") &&
    isLLMContent(input.content) &&
    (!("toolCalls" in input) || (Array.isArray(input.toolCalls) &&
      input.toolCalls.every((tc: unknown) => isLLMToolCall(tc)))) &&
    (!("toolCallId" in input) || typeof input.toolCallId === "string");
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
    (!("metadata" in input) || isLLMRequestMetadata(input.metadata)) &&
    (!("tools" in input) || (isRecord(input.tools) &&
      Object.values(input.tools).every((tool: unknown) => isLLMTool(tool))));
}

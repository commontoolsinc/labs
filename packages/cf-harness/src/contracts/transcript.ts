import type { ToolResultRef } from "./tool-result.ts";
import type { HarnessImageAttachment } from "./image.ts";
import type { LLMNativeModelToolResult } from "@commonfabric/llm/types";

export interface HarnessToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type HarnessNativeModelToolResult = LLMNativeModelToolResult;

export interface HarnessProviderContinuation {
  providerId: string;
  state: unknown;
}

export interface HarnessSystemTranscriptMessage {
  role: "system";
  content: string;
}

export interface HarnessUserTranscriptMessage {
  role: "user";
  content: string;
  imageAttachments?: readonly HarnessImageAttachment[];
}

export interface HarnessAssistantTranscriptMessage {
  role: "assistant";
  content: string;
  toolCalls?: readonly HarnessToolCall[];
  nativeModelToolResults?: readonly HarnessNativeModelToolResult[];
  providerContinuation?: HarnessProviderContinuation;
}

export interface HarnessToolTranscriptMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  resultRef?: ToolResultRef;
}

export type HarnessTranscriptMessage =
  | HarnessSystemTranscriptMessage
  | HarnessUserTranscriptMessage
  | HarnessAssistantTranscriptMessage
  | HarnessToolTranscriptMessage;

export interface HarnessTranscriptEvent {
  message: HarnessTranscriptMessage;
  transcript: readonly HarnessTranscriptMessage[];
}

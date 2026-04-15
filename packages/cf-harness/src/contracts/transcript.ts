import type { ToolResultRef } from "./tool-result.ts";

export interface HarnessToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface HarnessSystemTranscriptMessage {
  role: "system";
  content: string;
}

export interface HarnessUserTranscriptMessage {
  role: "user";
  content: string;
}

export interface HarnessAssistantTranscriptMessage {
  role: "assistant";
  content: string;
  toolCalls?: readonly HarnessToolCall[];
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

import {
  LLMContent,
  LLMGenerateObjectRequest,
  LLMGenerateObjectResponse,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  LLMToolResult,
} from "./types.ts";
import { type BuiltInLLMMessage } from "@commontools/api";

type PartialCallback = (text: string) => void;

let llmApiUrl = typeof globalThis.location !== "undefined"
  ? globalThis.location.protocol + "//" + globalThis.location.host +
    "/api/ai/llm"
  : Deno?.env.get("API_URL")
  ? new URL("/api/ai/llm", Deno.env.get("API_URL")).toString()
  : "//api/ai/llm";

export const setLLMUrl = (toolshedUrl: string) => {
  llmApiUrl = new URL("/api/ai/llm", toolshedUrl).toString();
};

export class LLMClient {
  async generateObject(
    request: LLMGenerateObjectRequest,
  ): Promise<LLMGenerateObjectResponse> {
    const response = await fetch(llmApiUrl + "/generateObject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `HTTP error! status: ${response.status}, body: ${errorText}`,
      );
    }

    const data = await response.json();
    return data;
  }

  /**
   * Sends a request to the LLM service.
   *
   * @param userRequest The LLM request object.
   * @param partialCB Optional callback for streaming text responses.
   * @param toolCallCB Optional callback for tool call events.
   * @returns The full LLM response with content and tool information.
   * @throws If the request fails after retrying with fallback models.
   */
  async sendRequest(
    request: LLMRequest,
    callback?: PartialCallback,
  ): Promise<LLMResponse> {
    if (request.stream && !callback) {
      throw new Error(
        "Requested an LLM request stream but no callback provided.",
      );
    }
    if (!request.stream && callback) {
      throw new Error(
        "Requested an LLM request with callback, but not configured as a stream.",
      );
    }

    const response = await fetch(llmApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `HTTP error! status: ${response.status}, body: ${errorText}`,
      );
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const id = response.headers.get("x-ct-llm-trace-id") as string;

    // the server might return cached data instead of a stream
    if (response.headers.get("content-type") === "application/json") {
      const data = (await response.json()) as BuiltInLLMMessage;
      return {
        content: data.content as string,
        id,
      };
    }
    return await this.stream(response.body, id, callback);
  }

  private async stream(
    body: ReadableStream,
    id: string,
    callback?: PartialCallback,
  ): Promise<LLMResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    let doneReading = false;
    let buffer = "";
    let text = "";
    const toolCalls: LLMToolCall[] = [];
    const toolResults: LLMToolResult[] = [];

    while (!doneReading) {
      const { value, done } = await reader.read();
      doneReading = done;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line) {
            try {
              const event = JSON.parse(line);

              // Handle different event types from AI SDK fullStream
              if (typeof event === "string") {
                // Legacy text delta format
                text += event;
                if (callback) callback(text);
              } else if (event.type === "text-delta") {
                // New structured text delta
                text += event.textDelta;
                if (callback) callback(text);
              } else if (event.type === "tool-call") {
                // Tool call event
                const toolCall: LLMToolCall = {
                  id: event.toolCallId,
                  name: event.toolName,
                  arguments: event.args,
                };
                toolCalls.push(toolCall);
              } else if (event.type === "tool-result") {
                // Tool result event
                const toolResult: LLMToolResult = {
                  toolCallId: event.toolCallId,
                  result: event.result,
                  error: event.error,
                };
                toolResults.push(toolResult);
              } else if (event.type === "finish") {
                // Stream finished
                break;
              }
            } catch (error) {
              console.error("Failed to parse JSON line:", line, error);
            }
          }
        }
      }
    }

    // Handle any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim());
        if (typeof event === "string") {
          text += event;
          if (callback) callback(text);
        }
      } catch (error) {
        console.error("Failed to parse final JSON line:", buffer, error);
      }
    }

    // Build content array with text and tool calls
    const content: any[] = [];
    
    if (text.trim()) {
      content.push({ type: "text", text });
    }
    
    // Add tool calls as content parts
    for (const toolCall of toolCalls) {
      content.push({
        type: "tool-call",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.arguments,
      });
    }

    return {
      role: "assistant",
      content: content.length > 0 ? content : text,
      id,
    };
  }
}

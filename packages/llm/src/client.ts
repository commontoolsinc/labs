import {
  LLMContent,
  LLMGenerateObjectRequest,
  LLMGenerateObjectResponse,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  LLMToolResult,
} from "./types.ts";

type PartialCallback = (text: string) => void;
type ToolCallCallback = (toolCall: LLMToolCall) => void;

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
    toolCallCallback?: ToolCallCallback,
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

    request.messages = request.messages.map(processMessage);

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
      const data = (await response.json()) as LLMMessage;
      return {
        content: data.content as string,
        id,
        // TODO: Extract tool calls from cached response if present
      };
    }
    return await this.stream(response.body, id, callback, toolCallCallback);
  }

  private async stream(
    body: ReadableStream,
    id: string,
    callback?: PartialCallback,
    toolCallCallback?: ToolCallCallback,
  ): Promise<LLMResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    let doneReading = false;
    let buffer = "";
    let text = "";
    let toolCalls: LLMToolCall[] = [];
    let toolResults: LLMToolResult[] = [];

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
                if (toolCallCallback) {
                  toolCallCallback(toolCall);
                }
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

    return {
      content: text,
      id,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
    };
  }
}

// FIXME(ja): we should either make message always a LLMMessage or update the types that
// iframes/recipes can generate
function processMessage(
  m: LLMMessage | string,
  idx: number,
): LLMMessage {
  if (typeof m === "string" || Array.isArray(m)) {
    return {
      role: idx % 2 === 0 ? "user" : "assistant",
      content: m,
    };
  }
  return m;
}

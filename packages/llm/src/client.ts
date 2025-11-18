import {
  LLMGenerateObjectRequest,
  LLMGenerateObjectResponse,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
  LLMToolResult,
} from "./types.ts";

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

// ============================================================================
// Mock Mode for Testing
// ============================================================================

type MockResponseMatcher = (request: LLMRequest) => boolean;
type MockObjectResponseMatcher = (request: LLMGenerateObjectRequest) => boolean;

interface MockResponse {
  matcher: MockResponseMatcher;
  response: LLMResponse;
}

interface MockObjectResponse {
  matcher: MockObjectResponseMatcher;
  response: LLMGenerateObjectResponse;
}

class MockCatalog {
  private mockResponses: MockResponse[] = [];
  private mockObjectResponses: MockObjectResponse[] = [];
  private enabled = false;

  /**
   * Enable mock mode - all LLM requests will be intercepted and matched
   * against registered mock responses instead of hitting the API.
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable mock mode - requests will go to the real API.
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Clear all registered mock responses.
   */
  clear(): void {
    this.mockResponses = [];
    this.mockObjectResponses = [];
  }

  /**
   * Reset mock mode - disable and clear all responses.
   */
  reset(): void {
    this.disable();
    this.clear();
  }

  /**
   * Check if mock mode is currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Register a mock response for sendRequest calls.
   * The matcher function should return true if this mock should be used for the given request.
   */
  addResponse(matcher: MockResponseMatcher, response: LLMResponse): void {
    this.mockResponses.push({ matcher, response });
  }

  /**
   * Register a mock response for generateObject calls.
   */
  addObjectResponse(
    matcher: MockObjectResponseMatcher,
    response: LLMGenerateObjectResponse,
  ): void {
    this.mockObjectResponses.push({ matcher, response });
  }

  /**
   * Find a matching mock response for the given request.
   * Returns undefined if no match is found.
   * Removes the matched mock from the catalog after finding it (one-time use).
   */
  findResponse(request: LLMRequest): LLMResponse | undefined {
    const index = this.mockResponses.findIndex((m) => m.matcher(request));
    if (index === -1) return undefined;

    // Remove and return the matched mock (one-time use)
    const [mock] = this.mockResponses.splice(index, 1);
    return mock.response;
  }

  /**
   * Find a matching mock object response for the given request.
   * Removes the matched mock from the catalog after finding it (one-time use).
   */
  findObjectResponse(
    request: LLMGenerateObjectRequest,
  ): LLMGenerateObjectResponse | undefined {
    const index = this.mockObjectResponses.findIndex((m) => m.matcher(request));
    if (index === -1) return undefined;

    // Remove and return the matched mock (one-time use)
    const [mock] = this.mockObjectResponses.splice(index, 1);
    return mock.response;
  }
}

// Global mock catalog
const mockCatalog = new MockCatalog();

/**
 * Enable mock mode for testing. When enabled, all LLM requests will be
 * intercepted and matched against registered mock responses.
 *
 * Example:
 * ```ts
 * import { enableMockMode, addMockResponse } from "@commontools/llm/client";
 *
 * enableMockMode();
 * addMockResponse(
 *   (req) => req.messages[0]?.content?.includes("test"),
 *   { role: "assistant", content: "mock response", id: "mock-1" }
 * );
 * ```
 */
export function enableMockMode(): void {
  mockCatalog.enable();
}

/**
 * Disable mock mode - requests will go to the real API.
 */
export function disableMockMode(): void {
  mockCatalog.disable();
}

/**
 * Clear all registered mock responses without disabling mock mode.
 */
export function clearMockResponses(): void {
  mockCatalog.clear();
}

/**
 * Reset mock mode - disable and clear all responses.
 */
export function resetMockMode(): void {
  mockCatalog.reset();
}

/**
 * Register a mock response for sendRequest calls.
 *
 * @param matcher Function that returns true if this mock should be used for the given request
 * @param response The LLM response to return
 *
 * Example:
 * ```ts
 * addMockResponse(
 *   (req) => req.messages.some(m => m.content?.includes("hello")),
 *   { role: "assistant", content: "Hi there!", id: "mock-1" }
 * );
 * ```
 */
export function addMockResponse(
  matcher: MockResponseMatcher,
  response: LLMResponse,
): void {
  mockCatalog.addResponse(matcher, response);
}

/**
 * Register a mock response for generateObject calls.
 *
 * @param matcher Function that returns true if this mock should be used for the given request
 * @param response The generate object response to return
 *
 * Example:
 * ```ts
 * addMockObjectResponse(
 *   (req) => req.schema.type === "object",
 *   { object: { name: "Test", value: 42 } }
 * );
 * ```
 */
export function addMockObjectResponse(
  matcher: MockObjectResponseMatcher,
  response: LLMGenerateObjectResponse,
): void {
  mockCatalog.addObjectResponse(matcher, response);
}

export class LLMClient {
  async generateObject(
    request: LLMGenerateObjectRequest,
    abortSignal?: AbortSignal,
  ): Promise<LLMGenerateObjectResponse> {
    // Check for mock mode
    if (mockCatalog.isEnabled()) {
      const mockResponse = mockCatalog.findObjectResponse(request);
      if (mockResponse) {
        // Simulate async behavior
        await new Promise((resolve) => setTimeout(resolve, 0));
        return mockResponse;
      }
      throw new Error(
        "Mock mode enabled but no matching mock response found for generateObject request",
      );
    }

    const response = await fetch(llmApiUrl + "/generateObject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abortSignal,
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
    abortSignal?: AbortSignal,
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

    // Check for mock mode
    if (mockCatalog.isEnabled()) {
      const mockResponse = mockCatalog.findResponse(request);
      if (mockResponse) {
        // Simulate streaming behavior if callback is provided
        if (callback && request.stream) {
          // Extract text from mock response content
          let text = "";
          if (typeof mockResponse.content === "string") {
            text = mockResponse.content;
          } else if (Array.isArray(mockResponse.content)) {
            const textPart = mockResponse.content.find((p: any) =>
              p.type === "text"
            ) as any;
            text = textPart?.text || "";
          }

          // Simulate streaming by calling callback with accumulated text
          if (text) {
            callback(text);
          }
        }

        // Simulate async behavior
        await new Promise((resolve) => setTimeout(resolve, 0));
        return mockResponse;
      }
      throw new Error(
        "Mock mode enabled but no matching mock response found for sendRequest",
      );
    }

    const response = await fetch(llmApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abortSignal,
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
      const data = await response.json();
      return {
        role: "assistant" as const,
        content: data.content,
        id,
      } as LLMResponse;
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
                  input: event.args,
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
        input: toolCall.input,
      });
    }

    return {
      role: "assistant",
      content: content.length > 0 ? content : text,
      id,
    };
  }
}

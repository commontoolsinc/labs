export interface OpenAICompatibleGatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export type OpenAIChatMessageRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIChatCompletionFunctionTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | boolean;
}

export interface OpenAIChatCompletionTool {
  type: "function";
  function: OpenAIChatCompletionFunctionTool;
}

export interface OpenAIChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenAIChatMessageContentPart =
  | {
    type: "text";
    text: string;
  }
  | Record<string, unknown>;

export type OpenAIChatMessageContent =
  | string
  | readonly OpenAIChatMessageContentPart[]
  | null;

export interface OpenAIChatCompletionMessage {
  role: OpenAIChatMessageRole;
  content: OpenAIChatMessageContent;
  tool_calls?: readonly OpenAIChatCompletionToolCall[];
  tool_call_id?: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: readonly OpenAIChatCompletionMessage[];
  tools?: readonly OpenAIChatCompletionTool[];
  tool_choice?: "auto" | "none" | Record<string, unknown>;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: OpenAIChatCompletionMessage;
  finish_reason?: string | null;
}

export interface OpenAIChatCompletionResponse {
  id?: string;
  choices: readonly OpenAIChatCompletionChoice[];
}

export class OpenAICompatibleGatewayClient {
  readonly baseUrl: URL;
  readonly apiKey?: string;
  readonly #fetchFn: typeof fetch;

  constructor(options: OpenAICompatibleGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.apiKey = options.apiKey;
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  endpoint(path: `/v1/${string}`): URL {
    return new URL(path, this.baseUrl);
  }

  headers(): HeadersInit {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async listModels(): Promise<Response> {
    return await this.#fetchFn(this.endpoint("/v1/models"), {
      headers: this.headers(),
    });
  }

  async createChatCompletion(
    payload: OpenAIChatCompletionRequest,
  ): Promise<Response> {
    return await this.#fetchFn(this.endpoint("/v1/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  async createChatCompletionJson(
    payload: OpenAIChatCompletionRequest,
  ): Promise<OpenAIChatCompletionResponse> {
    const response = await this.createChatCompletion(payload);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `chat completion request failed (${response.status}): ${body}`,
      );
    }
    return await response.json() as OpenAIChatCompletionResponse;
  }
}

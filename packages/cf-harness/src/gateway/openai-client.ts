export interface OpenAICompatibleGatewayClientOptions {
  baseUrl: string;
  authMode?: "bearer" | "none";
  apiKey?: string;
  apiKeySource?: string;
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
  readonly authMode: "bearer" | "none";
  readonly apiKey?: string;
  readonly apiKeySource?: string;
  readonly #fetchFn: typeof fetch;

  constructor(options: OpenAICompatibleGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.authMode = options.authMode ?? "bearer";
    this.apiKey = options.apiKey;
    this.apiKeySource = options.apiKeySource;
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  #requireApiKey(): string {
    const apiKey = this.apiKey?.trim();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY",
      );
    }
    if (apiKey === "...") {
      const sourceText = this.apiKeySource !== undefined
        ? `${this.apiKeySource} is set to a placeholder value ('...'); provide a real API key`
        : "the configured API key is a placeholder value ('...'); provide a real API key";
      throw new Error(sourceText);
    }
    return apiKey;
  }

  endpoint(path: `/v1/${string}`): URL {
    return new URL(path, this.baseUrl);
  }

  headers(): HeadersInit {
    if (this.authMode === "none") {
      return {
        "Content-Type": "application/json",
      };
    }
    const apiKey = this.#requireApiKey();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
      if (response.status === 401) {
        const sourceText = this.authMode === "none"
          ? "unauthenticated caller mode was used; gateway or upstream credentials rejected the request"
          : this.apiKeySource !== undefined
          ? `api key source: ${this.apiKeySource}; backend rejected the supplied key`
          : "supplied API key was rejected by the backend";
        throw new Error(
          `chat completion request failed (401, ${sourceText}): ${body}`,
        );
      }
      throw new Error(
        `chat completion request failed (${response.status}): ${body}`,
      );
    }
    return await response.json() as OpenAIChatCompletionResponse;
  }
}

export interface OpenAICompatibleGatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
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
    payload: Record<string, unknown>,
  ): Promise<Response> {
    return await this.#fetchFn(this.endpoint("/v1/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }
}

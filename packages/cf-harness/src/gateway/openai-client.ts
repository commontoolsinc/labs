import type { LLMNativeModelToolId } from "@commonfabric/llm/types";
import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";

export interface OpenAICompatibleGatewayClientOptions {
  baseUrl: string;
  authMode?: "bearer" | "none";
  apiKey?: string;
  apiKeySource?: string;
  chatCompletionTransportRetries?: number;
  chatCompletionRetryDelayMs?: number;
  fetchFn?: HarnessFetch;
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

export interface OpenAIChatCompletionNativeModelTool {
  type: LLMNativeModelToolId;
  google_search?: Record<string, never>;
}

export type OpenAIChatCompletionRequestTool =
  | OpenAIChatCompletionTool
  | OpenAIChatCompletionNativeModelTool;

export interface OpenAIChatCompletionNativeModelToolResult {
  type: LLMNativeModelToolId;
  provider?: string;
  providerMetadata?: unknown;
  sources?: unknown;
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
  grounding_metadata?: unknown;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: readonly OpenAIChatCompletionMessage[];
  tools?: readonly OpenAIChatCompletionRequestTool[];
  native_model_tools?: readonly OpenAIChatCompletionNativeModelTool[];
  tool_choice?: "auto" | "none" | Record<string, unknown>;
}

export interface OpenAIChatCompletionRequestDiagnosticSummary {
  model: string;
  messageCount: number;
  toolCount: number;
  nativeModelToolIds?: readonly LLMNativeModelToolId[];
  nativeModelToolCount: number;
  serializedBytes: number;
}

export type OpenAIChatCompletionAttemptOutcome =
  | "http_response"
  | "transport_error";

export interface OpenAIChatCompletionAttemptDiagnostic {
  type: "cf-harness.gateway.chat-completion-attempt";
  operation: "chat.completions";
  endpoint: string;
  attempt: number;
  maxTransportAttempts: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  request: OpenAIChatCompletionRequestDiagnosticSummary;
  outcome: OpenAIChatCompletionAttemptOutcome;
  httpStatus?: number;
  httpStatusText?: string;
  requestId?: string;
  responseHeaders?: Record<string, string>;
  responseBodyBytes?: number;
  responseBodyExcerpt?: string;
  responseBodyTruncated?: boolean;
  errorDetail?: string;
}

export interface OpenAIChatCompletionAttemptOptions {
  signal?: AbortSignal;
  onChatCompletionAttempt?: (
    diagnostic: OpenAIChatCompletionAttemptDiagnostic,
  ) => void | Promise<void>;
}

export interface OpenAIChatCompletionChoice {
  index: number;
  message: OpenAIChatCompletionMessage;
  finish_reason?: string | null;
}

export interface OpenAIChatCompletionResponse {
  id?: string;
  choices: readonly OpenAIChatCompletionChoice[];
  native_model_tool_results?:
    readonly OpenAIChatCompletionNativeModelToolResult[];
  provider_metadata?: Record<string, unknown>;
  sources?: readonly unknown[];
}

const DEFAULT_CHAT_COMPLETION_TRANSPORT_RETRIES = 1;
const DEFAULT_CHAT_COMPLETION_RETRY_DELAY_MS = 1_000;
const MAX_ERROR_BODY_EXCERPT_CHARS = 2_048;
const SELECTED_RESPONSE_HEADERS = [
  "x-request-id",
  "x-openai-request-id",
  "x-cf-request-id",
  "cf-ray",
  "retry-after",
  "content-type",
  "date",
] as const;
const REQUEST_ID_HEADER_NAMES = [
  "x-request-id",
  "x-openai-request-id",
  "x-cf-request-id",
  "cf-ray",
] as const;

const nonNegativeIntegerOrDefault = (
  input: number | undefined,
  fallback: number,
): number =>
  input !== undefined && Number.isInteger(input) && input >= 0
    ? input
    : fallback;

const chatCompletionAbortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException(
    "chat completion request aborted",
    "AbortError",
  );

const throwIfChatCompletionAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw chatCompletionAbortReason(signal);
  }
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  throwIfChatCompletionAborted(signal);
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(chatCompletionAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const textByteLength = (input: string): number =>
  new TextEncoder().encode(input).byteLength;

const summarizeChatCompletionRequest = (
  payload: OpenAIChatCompletionRequest,
  serializedPayload: string,
): OpenAIChatCompletionRequestDiagnosticSummary => {
  const nativeModelToolIds = [
    ...(payload.native_model_tools?.map((tool) => tool.type) ?? []),
    ...(payload.tools?.flatMap((tool) =>
      tool.type === "function" ? [] : [tool.type]
    ) ?? []),
  ];
  return {
    model: payload.model,
    messageCount: payload.messages.length,
    toolCount: payload.tools?.length ?? 0,
    ...(nativeModelToolIds.length > 0
      ? { nativeModelToolIds: [...nativeModelToolIds] }
      : {}),
    nativeModelToolCount: nativeModelToolIds.length,
    serializedBytes: textByteLength(serializedPayload),
  };
};

const selectResponseHeaders = (
  headers: Headers,
): Record<string, string> | undefined => {
  const selected: Record<string, string> = {};
  for (const header of SELECTED_RESPONSE_HEADERS) {
    const value = headers.get(header);
    if (value !== null) {
      selected[header] = value;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
};

const selectRequestId = (headers: Headers): string | undefined => {
  for (const header of REQUEST_ID_HEADER_NAMES) {
    const value = headers.get(header);
    if (value !== null && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
};

const responseBodyDiagnosticFields = (body: string) => ({
  responseBodyBytes: textByteLength(body),
  responseBodyExcerpt: body.slice(0, MAX_ERROR_BODY_EXCERPT_CHARS),
  responseBodyTruncated: body.length > MAX_ERROR_BODY_EXCERPT_CHARS,
});

const emitChatCompletionAttempt = async (
  options: OpenAIChatCompletionAttemptOptions | undefined,
  diagnostic: OpenAIChatCompletionAttemptDiagnostic,
): Promise<void> => {
  try {
    await options?.onChatCompletionAttempt?.(diagnostic);
  } catch {
    // Diagnostics must not change gateway request behavior.
  }
};

const transportErrorAfterRetries = (
  endpoint: URL,
  attempts: number,
  error: unknown,
): Error =>
  new Error(
    `chat completion transport request failed after ${attempts} ${
      attempts === 1 ? "attempt" : "attempts"
    } for ${endpoint.toString()}: ${errorMessage(error)}`,
  );

interface ChatCompletionFetchResult {
  response: Response;
  diagnostic: OpenAIChatCompletionAttemptDiagnostic;
}

export class OpenAICompatibleGatewayClient {
  readonly baseUrl: URL;
  readonly authMode: "bearer" | "none";
  readonly apiKey?: string;
  readonly apiKeySource?: string;
  readonly #fetchFn: HarnessFetch;
  readonly #chatCompletionTransportRetries: number;
  readonly #chatCompletionRetryDelayMs: number;

  constructor(options: OpenAICompatibleGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.authMode = options.authMode ?? "bearer";
    this.apiKey = options.apiKey;
    this.apiKeySource = options.apiKeySource;
    this.#fetchFn = options.fetchFn ?? defaultHarnessFetch;
    this.#chatCompletionTransportRetries = nonNegativeIntegerOrDefault(
      options.chatCompletionTransportRetries,
      DEFAULT_CHAT_COMPLETION_TRANSPORT_RETRIES,
    );
    this.#chatCompletionRetryDelayMs = nonNegativeIntegerOrDefault(
      options.chatCompletionRetryDelayMs,
      DEFAULT_CHAT_COMPLETION_RETRY_DELAY_MS,
    );
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

  async listModels(signal?: AbortSignal): Promise<Response> {
    return await this.#fetchFn(this.endpoint("/v1/models"), {
      headers: this.headers(),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async createChatCompletion(
    payload: OpenAIChatCompletionRequest,
    options: OpenAIChatCompletionAttemptOptions = {},
  ): Promise<Response> {
    const { response, diagnostic } = await this.#fetchChatCompletion(
      payload,
      options,
    );
    await emitChatCompletionAttempt(options, diagnostic);
    return response;
  }

  async #fetchChatCompletion(
    payload: OpenAIChatCompletionRequest,
    options: OpenAIChatCompletionAttemptOptions,
  ): Promise<ChatCompletionFetchResult> {
    const endpoint = this.endpoint("/v1/chat/completions");
    const serializedPayload = JSON.stringify(payload);
    const request = summarizeChatCompletionRequest(payload, serializedPayload);
    const init: RequestInit = {
      method: "POST",
      headers: this.headers(),
      body: serializedPayload,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const maxTransportAttempts = this.#chatCompletionTransportRetries + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTransportAttempts; attempt += 1) {
      throwIfChatCompletionAborted(options.signal);
      const startedAt = new Date();
      const startedAtMs = performance.now();
      try {
        const response = await this.#fetchFn(endpoint, init);
        const endedAt = new Date();
        const responseHeaders = selectResponseHeaders(response.headers);
        const requestId = selectRequestId(response.headers);
        return {
          response,
          diagnostic: {
            type: "cf-harness.gateway.chat-completion-attempt",
            operation: "chat.completions",
            endpoint: endpoint.toString(),
            attempt,
            maxTransportAttempts,
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            durationMs: Math.max(
              0,
              Math.round(performance.now() - startedAtMs),
            ),
            request,
            outcome: "http_response",
            httpStatus: response.status,
            httpStatusText: response.statusText,
            ...(requestId !== undefined ? { requestId } : {}),
            ...(responseHeaders !== undefined ? { responseHeaders } : {}),
          },
        };
      } catch (error) {
        lastError = error;
        const endedAt = new Date();
        await emitChatCompletionAttempt(options, {
          type: "cf-harness.gateway.chat-completion-attempt",
          operation: "chat.completions",
          endpoint: endpoint.toString(),
          attempt,
          maxTransportAttempts,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
          request,
          outcome: "transport_error",
          errorDetail: errorMessage(error),
        });
        if (options.signal?.aborted) {
          throw chatCompletionAbortReason(options.signal);
        }
        if (attempt >= maxTransportAttempts) {
          throw transportErrorAfterRetries(endpoint, attempt, error);
        }
        await sleep(this.#chatCompletionRetryDelayMs * attempt, options.signal);
      }
    }
    throw transportErrorAfterRetries(endpoint, maxTransportAttempts, lastError);
  }

  async createChatCompletionJson(
    payload: OpenAIChatCompletionRequest,
    options: OpenAIChatCompletionAttemptOptions = {},
  ): Promise<OpenAIChatCompletionResponse> {
    const { response, diagnostic } = await this.#fetchChatCompletion(
      payload,
      options,
    );
    if (!response.ok) {
      const body = await response.text();
      await emitChatCompletionAttempt(options, {
        ...diagnostic,
        ...responseBodyDiagnosticFields(body),
      });
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
    await emitChatCompletionAttempt(options, diagnostic);
    return await response.json() as OpenAIChatCompletionResponse;
  }
}

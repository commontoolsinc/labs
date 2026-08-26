import type { LLMNativeModelToolId } from "@commonfabric/llm/types";
import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";
import {
  currentProvenance,
  type HarnessProvenance,
  provenanceHeaders,
  provenanceUserAgent,
} from "../provenance.ts";

export interface OpenAICompatibleGatewayClientOptions {
  baseUrl: string;
  authMode?: "bearer" | "none";
  apiKey?: string;
  apiKeySource?: string;
  chatCompletionTransportRetries?: number;
  chatCompletionRetryDelayMs?: number;
  fetchFn?: HarnessFetch;

  /**
   * What caused these requests. Resolved from the process when absent.
   */
  provenance?: HarnessProvenance;
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

  /** Absent on tool-call-only turns from some providers, not just null. */
  content?: OpenAIChatMessageContent;
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

/**
 * OpenAI Responses API payloads.
 *
 * The gateway serves `/v1/responses` for OpenAI-backed models. Unlike
 * `/v1/chat/completions`, it accepts function tools together with reasoning,
 * which is why cf-harness prefers it for reasoning models.
 */
export type OpenAIResponsesInputItem = Record<string, unknown>;

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: readonly OpenAIResponsesInputItem[];
  tools?: readonly OpenAIResponsesInputItem[];
  tool_choice?: "auto" | "none" | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  store?: boolean;
  stream?: boolean;
  include?: readonly string[];

  /**
   * Server-side compaction. When rendered tokens cross `compact_threshold`,
   * the provider folds prior context into an encrypted compaction item and
   * prunes before continuing inference.
   */
  context_management?: readonly {
    type: "compaction";
    compact_threshold: number;
  }[];
  prompt_cache_key?: string;
  prompt_cache_options?: {
    mode: "implicit" | "explicit";
    ttl?: "30m";
  };
  reasoning?: {
    effort: string;
  };
}

export interface OpenAIResponsesResponse {
  id?: string;
  status?: string;
  output?: readonly unknown[];
  usage?: Record<string, unknown>;
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

export type OpenAIGatewayOperation = "chat.completions" | "responses";

export interface OpenAIChatCompletionAttemptDiagnostic {
  type: "cf-harness.gateway.chat-completion-attempt";
  operation: OpenAIGatewayOperation;
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
  usage?: Record<string, unknown>;
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

const summarizeResponsesRequest = (
  payload: OpenAIResponsesRequest,
  serializedPayload: string,
): OpenAIChatCompletionRequestDiagnosticSummary => ({
  model: payload.model,
  // `instructions` carries the system prompt, so count it alongside input items
  // to keep this comparable with the chat-completions message count.
  messageCount: payload.input.length +
    (payload.instructions !== undefined ? 1 : 0),
  toolCount: payload.tools?.length ?? 0,
  nativeModelToolCount: 0,
  serializedBytes: textByteLength(serializedPayload),
});

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
  operation: OpenAIGatewayOperation,
  endpoint: URL,
  attempts: number,
  error: unknown,
): Error =>
  // Names the operation so a Responses failure is not reported as a chat
  // completion one. `diagnostics.ts` classifies timeouts by matching
  // "transport request failed", which stays stable across both operations.
  new Error(
    `${operation} transport request failed after ${attempts} ${
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
  readonly #provenance?: HarnessProvenance;

  constructor(options: OpenAICompatibleGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.authMode = options.authMode ?? "bearer";
    this.apiKey = options.apiKey;
    this.apiKeySource = options.apiKeySource;
    this.#fetchFn = options.fetchFn ?? defaultHarnessFetch;
    this.#provenance = options.provenance;
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

  /**
   * The headers every request carries, including the provenance that tells the
   * gateway what caused it.
   */
  headers(): HeadersInit {
    const provenance = this.#provenance ?? currentProvenance();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": provenanceUserAgent(provenance),
      ...provenanceHeaders(provenance),
    };
    if (this.authMode === "none") return headers;
    headers.Authorization = `Bearer ${this.#requireApiKey()}`;
    return headers;
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
    const serializedPayload = JSON.stringify(payload);
    return await this.#fetchOperation(
      this.endpoint("/v1/chat/completions"),
      "chat.completions",
      serializedPayload,
      summarizeChatCompletionRequest(payload, serializedPayload),
      options,
    );
  }

  async #fetchResponses(
    payload: OpenAIResponsesRequest,
    options: OpenAIChatCompletionAttemptOptions,
  ): Promise<ChatCompletionFetchResult> {
    const serializedPayload = JSON.stringify(payload);
    return await this.#fetchOperation(
      this.endpoint("/v1/responses"),
      "responses",
      serializedPayload,
      summarizeResponsesRequest(payload, serializedPayload),
      options,
    );
  }

  async #fetchOperation(
    endpoint: URL,
    operation: OpenAIGatewayOperation,
    serializedPayload: string,
    request: OpenAIChatCompletionRequestDiagnosticSummary,
    options: OpenAIChatCompletionAttemptOptions,
  ): Promise<ChatCompletionFetchResult> {
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
            operation: operation,
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
          operation: operation,
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
          throw transportErrorAfterRetries(operation, endpoint, attempt, error);
        }
        await sleep(this.#chatCompletionRetryDelayMs * attempt, options.signal);
      }
    }
    throw transportErrorAfterRetries(
      operation,
      endpoint,
      maxTransportAttempts,
      lastError,
    );
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

  async createResponseJson(
    payload: OpenAIResponsesRequest,
    options: OpenAIChatCompletionAttemptOptions = {},
  ): Promise<OpenAIResponsesResponse> {
    const { response, diagnostic } = await this.#fetchResponses(
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
          `responses request failed (401, ${sourceText}): ${body}`,
        );
      }
      // Gateways that front non-OpenAI providers (for example Vertex-backed
      // Claude and Gemini) cannot translate the Responses API and fail without
      // a usable body. Name that case so the model choice is the obvious fix.
      if (response.status >= 500 && body.trim() === "") {
        throw new Error(
          `responses request failed (${response.status}) with an empty body for model ${payload.model}; ` +
            "the gateway may not support the Responses API for this model's provider",
        );
      }
      throw new Error(
        `responses request failed (${response.status}): ${body}`,
      );
    }
    await emitChatCompletionAttempt(options, diagnostic);
    return await response.json() as OpenAIResponsesResponse;
  }
}

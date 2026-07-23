import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessProviderContinuation,
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import type { HarnessFetch } from "../contracts/http-fetch.ts";
import { defaultHarnessFetch } from "../contracts/http-fetch.ts";
import { materializeImageAttachmentContentPart } from "../image-attachments.ts";
import type { OpenAICodexOAuthCredential } from "../auth/types.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelCatalogEntry,
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "./client.ts";

export const OPENAI_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_CODEX_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const OPENAI_CODEX_CLIENT_VERSION = "0.0.0";

export interface OpenAICodexCredentialResolverLike {
  resolve(): Promise<OpenAICodexOAuthCredential>;
}

export interface OpenAICodexResponsesClientOptions {
  credentialResolver: OpenAICodexCredentialResolverLike;
  fetchFn?: HarnessFetch;
  endpoint?: string;
  now?: () => Date;
}

type ResponsesInputItem = Record<string, unknown>;

const textBytes = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

const redactCredentialValues = (
  text: string,
  credential: OpenAICodexOAuthCredential,
): string => {
  let redacted = text;
  for (
    const secret of [
      credential.accessToken,
      credential.refreshToken,
      credential.accountId,
    ]
  ) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
};

const continuationOutput = (
  continuation: HarnessProviderContinuation | undefined,
): ResponsesInputItem[] => {
  if (continuation?.providerId !== "openai-codex") return [];
  const state = continuation.state;
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return [];
  }
  const output = (state as Record<string, unknown>).output;
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) =>
    typeof item === "object" && item !== null &&
      (item as Record<string, unknown>).type === "reasoning" &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).encrypted_content === "string"
      ? [structuredClone(item as ResponsesInputItem)]
      : []
  );
};

const continuationFunctionCallItemId = (
  continuation: HarnessProviderContinuation | undefined,
  callId: string,
): string | undefined => {
  if (
    continuation?.providerId !== "openai-codex" ||
    typeof continuation.state !== "object" || continuation.state === null ||
    Array.isArray(continuation.state)
  ) return undefined;
  const ids = (continuation.state as Record<string, unknown>)
    .functionCallItemIds;
  if (typeof ids !== "object" || ids === null || Array.isArray(ids)) {
    return undefined;
  }
  const itemId = (ids as Record<string, unknown>)[callId];
  return typeof itemId === "string" ? itemId : undefined;
};

const materializeUserContent = async (
  message: Extract<HarnessTranscriptMessage, { role: "user" }>,
): Promise<ResponsesInputItem[]> => {
  const content: ResponsesInputItem[] = message.content.length > 0
    ? [{ type: "input_text", text: message.content }]
    : [];
  for (const attachment of message.imageAttachments ?? []) {
    const part = await materializeImageAttachmentContentPart(attachment);
    const partRecord = part as Record<string, unknown>;
    const imageUrl =
      typeof partRecord.image_url === "object" && partRecord.image_url !== null
        ? (partRecord.image_url as Record<string, unknown>).url
        : undefined;
    if (typeof imageUrl !== "string") {
      throw new Error(
        "failed to materialize image attachment for Codex Responses",
      );
    }
    content.push({ type: "input_image", detail: "auto", image_url: imageUrl });
  }
  return content;
};

const toResponsesInput = async (
  transcript: readonly HarnessTranscriptMessage[],
): Promise<{ instructions: string; input: ResponsesInputItem[] }> => {
  const instructions = transcript.filter((message) => message.role === "system")
    .map((message) => message.content).join("\n\n") ||
    "You are a helpful assistant.";
  const input: ResponsesInputItem[] = [];
  for (const [index, message] of transcript.entries()) {
    switch (message.role) {
      case "system":
        break;
      case "user": {
        const content = await materializeUserContent(message);
        if (content.length > 0) input.push({ role: "user", content });
        break;
      }
      case "assistant":
        input.push(...continuationOutput(message.providerContinuation));
        if (message.content.length > 0) {
          input.push({
            type: "message",
            id: `msg_cf_${index}`,
            role: "assistant",
            status: "completed",
            content: [{
              type: "output_text",
              text: message.content,
              annotations: [],
            }],
          });
        }
        for (const call of message.toolCalls ?? []) {
          const itemId = continuationFunctionCallItemId(
            message.providerContinuation,
            call.id,
          );
          input.push({
            type: "function_call",
            ...(itemId !== undefined ? { id: itemId } : {}),
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        });
        break;
    }
  }
  return { instructions, input };
};

const toResponsesTools = (
  tools: readonly HarnessToolDescriptor[],
): ResponsesInputItem[] =>
  tools.map((tool) => ({
    type: "function",
    name: tool.toolId,
    description: tool.description,
    parameters: typeof tool.inputSchema === "boolean"
      ? tool.inputSchema
      : { ...tool.inputSchema },
    strict: null,
  }));

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("operation aborted", "AbortError");

async function* parseSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    throw new Error("Codex Responses stream did not include a body");
  }
  const reader = response.body.getReader();
  if (signal?.aborted) {
    await reader.cancel(signal.reason);
    throw abortReason(signal);
  }
  const onAbort = () => {
    void reader.cancel(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortReason(signal);
      buffered += decoder.decode(value, { stream: !done });
      buffered = buffered.replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = block.split("\n").filter((line) =>
          line.startsWith("data:")
        )
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new Error("Codex Responses stream contained malformed JSON");
        }
        if (
          typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
        ) {
          throw new Error(
            "Codex Responses stream contained a non-object event",
          );
        }
        yield parsed as Record<string, unknown>;
      }
      if (done) break;
    }
    if (buffered.trim().length > 0) {
      throw new Error(
        "Codex Responses stream ended with an incomplete SSE event",
      );
    }
    completed = true;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

const normalizeTerminalResponse = (
  response: Record<string, unknown>,
): HarnessAssistantTranscriptMessage => {
  const status = response.status;
  if (
    status === "incomplete" || status === "failed" || status === "cancelled"
  ) {
    throw new Error(`Codex Responses ended with status ${String(status)}`);
  }
  if (status !== "completed") {
    throw new Error("Codex Responses terminal event has an unknown status");
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    throw new Error("Codex Responses terminal event did not include output");
  }
  const text: string[] = [];
  const toolCalls: HarnessToolCall[] = [];
  const toolCallById = new Map<string, HarnessToolCall>();
  const continuation: ResponsesInputItem[] = [];
  const functionCallItemIds: Record<string, string> = {};
  for (const rawItem of output) {
    if (
      typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)
    ) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawContent of item.content) {
        if (typeof rawContent !== "object" || rawContent === null) continue;
        const content = rawContent as Record<string, unknown>;
        if (
          content.type === "output_text" && typeof content.text === "string"
        ) {
          text.push(content.text);
        }
      }
    } else if (item.type === "function_call") {
      if (
        typeof item.call_id !== "string" || typeof item.name !== "string" ||
        typeof item.arguments !== "string"
      ) {
        throw new Error("Codex Responses included an incomplete tool call");
      }
      const call: HarnessToolCall = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      };
      if (typeof item.id === "string") {
        functionCallItemIds[call.id] = item.id;
      }
      const previous = toolCallById.get(call.id);
      if (previous !== undefined) {
        if (JSON.stringify(previous) !== JSON.stringify(call)) {
          throw new Error(
            "Codex Responses included conflicting duplicate tool-call ids",
          );
        }
        continue;
      }
      toolCallById.set(call.id, call);
      toolCalls.push(call);
    } else if (
      item.type === "reasoning" && typeof item.id === "string" &&
      typeof item.encrypted_content === "string"
    ) {
      continuation.push(structuredClone(item));
    }
  }
  return {
    role: "assistant",
    content: text.join(""),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(continuation.length > 0 || Object.keys(functionCallItemIds).length > 0
      ? {
        providerContinuation: {
          providerId: "openai-codex",
          state: {
            ...(typeof response.id === "string"
              ? { responseId: response.id }
              : {}),
            output: continuation,
            ...(Object.keys(functionCallItemIds).length > 0
              ? { functionCallItemIds }
              : {}),
          },
        },
      }
      : {}),
  };
};

const selectedHeaders = (
  headers: Headers,
): Record<string, string> | undefined => {
  const selected: Record<string, string> = {};
  for (
    const name of [
      "x-request-id",
      "x-openai-request-id",
      "retry-after",
      "content-type",
    ]
  ) {
    const value = headers.get(name);
    if (value) selected[name] = value;
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
};

const emitAttempt = async (
  observer: HarnessModelTurnRequest["onAttempt"],
  attempt: HarnessModelAttemptDiagnostic,
): Promise<void> => {
  try {
    await observer?.(attempt);
  } catch {
    // Diagnostics cannot change provider behavior.
  }
};

export class OpenAICodexResponsesClient implements HarnessModelClient {
  readonly providerId = "openai-codex";
  readonly #resolver: OpenAICodexCredentialResolverLike;
  readonly #fetchFn: HarnessFetch;
  readonly #endpoint: string;
  readonly #now: () => Date;

  constructor(options: OpenAICodexResponsesClientOptions) {
    this.#resolver = options.credentialResolver;
    this.#fetchFn = options.fetchFn ?? defaultHarnessFetch;
    this.#endpoint = options.endpoint ?? OPENAI_CODEX_RESPONSES_URL;
    if (this.#endpoint !== OPENAI_CODEX_RESPONSES_URL) {
      throw new Error(
        "OpenAI Codex credentials may only be sent to the pinned Responses endpoint",
      );
    }
    this.#now = options.now ?? (() => new Date());
  }

  async listModels(
    signal?: AbortSignal,
  ): Promise<readonly HarnessModelCatalogEntry[]> {
    const credential = await this.#resolver.resolve();
    const url = new URL(OPENAI_CODEX_MODELS_URL);
    url.searchParams.set("client_version", OPENAI_CODEX_CLIENT_VERSION);
    const response = await this.#fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "chatgpt-account-id": credential.accountId,
        originator: "cf-harness",
        "User-Agent": "cf-harness",
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `OpenAI Codex model discovery failed (${response.status})`,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new Error("OpenAI Codex model discovery returned invalid JSON");
    }
    if (!Array.isArray(body.models)) {
      throw new Error("OpenAI Codex model discovery omitted the models array");
    }
    return body.models.map((raw): HarnessModelCatalogEntry => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(
          "OpenAI Codex model discovery returned an invalid model",
        );
      }
      const model = raw as Record<string, unknown>;
      if (
        typeof model.slug !== "string" ||
        typeof model.display_name !== "string"
      ) {
        throw new Error(
          "OpenAI Codex model discovery returned an invalid model",
        );
      }
      const efforts = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.flatMap((entry) =>
          typeof entry === "object" && entry !== null &&
            typeof (entry as Record<string, unknown>).effort === "string"
            ? [(entry as Record<string, unknown>).effort as string]
            : []
        )
        : [];
      const modalities = Array.isArray(model.input_modalities)
        ? model.input_modalities.filter((value): value is string =>
          typeof value === "string"
        )
        : [];
      return {
        id: model.slug,
        displayName: model.display_name,
        ...(typeof model.description === "string"
          ? { description: model.description }
          : {}),
        inputModalities: modalities,
        supportedReasoningEfforts: efforts,
        supportsParallelToolCalls: model.supports_parallel_tool_calls === true,
      };
    });
  }

  async complete(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    if (request.nativeModelToolIds.length > 0) {
      throw new Error(
        "openai-codex does not support provider-native tools in this release",
      );
    }
    const credential = await this.#resolver.resolve();
    const converted = await toResponsesInput(request.transcript);
    const responseTools = toResponsesTools(request.tools);
    const body = JSON.stringify({
      model: request.model,
      store: false,
      stream: true,
      instructions: converted.instructions,
      input: converted.input,
      ...(responseTools.length > 0 ? { tools: responseTools } : {}),
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: request.runId,
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    const startedAt = this.#now();
    const startedAtMs = performance.now();
    let response: Response;
    try {
      response = await this.#fetchFn(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "chatgpt-account-id": credential.accountId,
          originator: "cf-harness",
          "User-Agent": "cf-harness",
          "OpenAI-Beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
          "session-id": request.runId,
          "x-client-request-id": request.runId,
        },
        body,
        signal: request.signal,
      });
    } catch (error) {
      const endedAt = this.#now();
      const errorDetail = redactCredentialValues(
        error instanceof Error ? error.message : String(error),
        credential,
      );
      await emitAttempt(request.onAttempt, {
        type: "cf-harness.model-attempt",
        providerId: this.providerId,
        operation: "responses.stream",
        endpoint: this.#endpoint,
        attempt: 1,
        maxTransportAttempts: 1,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
        request: {
          model: request.model,
          messageCount: request.transcript.length,
          toolCount: request.tools.length,
          nativeModelToolCount: 0,
          serializedBytes: textBytes(body),
        },
        outcome: "transport_error",
        errorDetail,
      });
      if (
        error instanceof DOMException && error.name === "AbortError" &&
        errorDetail === error.message
      ) {
        throw error;
      }
      throw new Error(errorDetail, { cause: error });
    }
    const endedAt = this.#now();
    const baseAttempt: HarnessModelAttemptDiagnostic = {
      type: "cf-harness.model-attempt",
      providerId: this.providerId,
      operation: "responses.stream",
      endpoint: this.#endpoint,
      attempt: 1,
      maxTransportAttempts: 1,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
      request: {
        model: request.model,
        messageCount: request.transcript.length,
        toolCount: request.tools.length,
        nativeModelToolCount: 0,
        serializedBytes: textBytes(body),
      },
      outcome: "http_response",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      ...(selectedHeaders(response.headers) !== undefined
        ? { responseHeaders: selectedHeaders(response.headers) }
        : {}),
    };
    if (!response.ok) {
      const errorBody = await response.text();
      await emitAttempt(request.onAttempt, {
        ...baseAttempt,
        responseBodyBytes: textBytes(errorBody),
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        throw new Error(
          `OpenAI Codex usage limit reached${
            retryAfter ? `; retry after ${retryAfter}` : ""
          }`,
        );
      }
      throw new Error(
        `OpenAI Codex Responses request failed (${response.status})`,
      );
    }
    await emitAttempt(request.onAttempt, baseAttempt);
    let terminal: Record<string, unknown> | undefined;
    for await (const event of parseSse(response, request.signal)) {
      const type = event.type;
      if (type === "error") {
        throw new Error(
          "OpenAI Codex Responses stream returned an error event",
        );
      }
      if (
        type === "response.completed" || type === "response.done" ||
        type === "response.incomplete"
      ) {
        if (
          typeof event.response !== "object" || event.response === null ||
          Array.isArray(event.response)
        ) {
          throw new Error(
            "Codex Responses terminal event did not include a response object",
          );
        }
        terminal = event.response as Record<string, unknown>;
      }
    }
    if (!terminal) {
      throw new Error(
        "Codex Responses stream ended without a terminal response event",
      );
    }
    const usage = typeof terminal.usage === "object" &&
        terminal.usage !== null && !Array.isArray(terminal.usage)
      ? terminal.usage as Record<string, unknown>
      : undefined;
    return {
      assistant: normalizeTerminalResponse(terminal),
      ...(usage !== undefined
        ? {
          usage: {
            ...(typeof usage.input_tokens === "number"
              ? { inputTokens: usage.input_tokens }
              : {}),
            ...(typeof usage.output_tokens === "number"
              ? { outputTokens: usage.output_tokens }
              : {}),
            ...(typeof usage.total_tokens === "number"
              ? { totalTokens: usage.total_tokens }
              : {}),
          },
        }
        : {}),
    };
  }
}

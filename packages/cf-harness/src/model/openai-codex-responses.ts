import type { HarnessFetch } from "../contracts/http-fetch.ts";
import {
  type HarnessCredentialOwnerRef,
  harnessCredentialOwnersEqual,
} from "../contracts/run-manifest.ts";
import { defaultHarnessFetch } from "../contracts/http-fetch.ts";
import {
  normalizeTerminalResponse,
  providerRunAffinityKey,
  toResponsesInput,
  toResponsesTools,
} from "./responses-protocol.ts";
import type { OpenAICodexOAuthCredential } from "../auth/types.ts";
import { HarnessControlError } from "../control-errors.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelCatalogEntry,
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "./client.ts";
import { normalizeOpenAIUsage } from "./usage.ts";

export const OPENAI_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_CODEX_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const OPENAI_CODEX_CLIENT_VERSION = "0.0.0";

export interface OpenAICodexCredentialResolverLike {
  readonly ownerKey?: string;
  readonly credentialOwner?: HarnessCredentialOwnerRef;
  resolve(signal?: AbortSignal): Promise<OpenAICodexOAuthCredential>;
}

export interface OpenAICodexResponsesClientOptions {
  credentialResolver: OpenAICodexCredentialResolverLike;
  credentialOwner?: HarnessCredentialOwnerRef;
  fetchFn?: HarnessFetch;
  endpoint?: string;
  now?: () => Date;
}

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_RESPONSES_LABEL = "Codex Responses";

const providerUnavailable = (message: string): HarnessControlError =>
  new HarnessControlError("provider-unavailable", message);

const providerAuthRequired = (message: string): HarnessControlError =>
  new HarnessControlError("provider-auth-required", message);

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

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("operation aborted", "AbortError");

async function* parseSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    throw providerUnavailable("Codex Responses stream did not include a body");
  }
  const reader = response.body.getReader();
  if (signal?.aborted) {
    await reader.cancel(signal.reason).catch(() => {});
    throw abortReason(signal);
  }
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  let completed = false;
  try {
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch {
        if (signal?.aborted) throw abortReason(signal);
        throw providerUnavailable("Codex Responses stream read failed");
      }
      const { value, done } = read;
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
          throw providerUnavailable(
            "Codex Responses stream contained malformed JSON",
          );
        }
        if (
          typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
        ) {
          throw providerUnavailable(
            "Codex Responses stream contained a non-object event",
          );
        }
        yield parsed as Record<string, unknown>;
      }
      if (done) break;
    }
    if (buffered.trim().length > 0) {
      throw providerUnavailable(
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

const selectedHeaders = (
  headers: Headers,
): Record<string, string> | undefined => {
  const selected: Record<string, string> = {};
  for (
    const name of [
      "x-request-id",
      "x-openai-request-id",
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
  readonly credentialOwner?: HarnessCredentialOwnerRef;
  readonly #resolver: OpenAICodexCredentialResolverLike;
  readonly #fetchFn: HarnessFetch;
  readonly #endpoint: string;
  readonly #now: () => Date;

  constructor(options: OpenAICodexResponsesClientOptions) {
    this.#resolver = options.credentialResolver;
    const resolverOwner = options.credentialResolver.credentialOwner;
    const credentialOwner = options.credentialOwner ?? resolverOwner;
    if (
      credentialOwner !== undefined && resolverOwner !== undefined &&
      !harnessCredentialOwnersEqual(credentialOwner, resolverOwner)
    ) {
      throw new Error(
        "Codex credential resolver owner does not match the client owner",
      );
    }
    if (
      credentialOwner !== undefined &&
      options.credentialResolver.ownerKey !== undefined &&
      credentialOwner.ownerKey !== options.credentialResolver.ownerKey
    ) {
      throw new Error(
        "Codex credential resolver owner does not match the client owner",
      );
    }
    this.credentialOwner = credentialOwner === undefined
      ? undefined
      : structuredClone(credentialOwner);
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
    const credential = await this.#resolver.resolve(signal);
    if (signal?.aborted) throw abortReason(signal);
    const url = new URL(OPENAI_CODEX_MODELS_URL);
    url.searchParams.set("client_version", OPENAI_CODEX_CLIENT_VERSION);
    let response: Response;
    try {
      response = await this.#fetchFn(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "chatgpt-account-id": credential.accountId,
          originator: "cf-harness",
          "User-Agent": "cf-harness",
        },
        signal,
      });
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw providerUnavailable("OpenAI Codex model discovery failed");
    }
    if (signal?.aborted) {
      await response.body?.cancel(signal.reason).catch(() => {});
      throw abortReason(signal);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw providerAuthRequired(
          "OpenAI Codex authentication is no longer accepted",
        );
      }
      throw providerUnavailable(
        `OpenAI Codex model discovery failed (${response.status})`,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      throw providerUnavailable(
        "OpenAI Codex model discovery returned invalid JSON",
      );
    }
    if (signal?.aborted) throw abortReason(signal);
    if (!Array.isArray(body.models)) {
      throw providerUnavailable(
        "OpenAI Codex model discovery omitted the models array",
      );
    }
    return body.models.map((raw): HarnessModelCatalogEntry => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw providerUnavailable(
          "OpenAI Codex model discovery returned an invalid model",
        );
      }
      const model = raw as Record<string, unknown>;
      if (
        typeof model.slug !== "string" ||
        typeof model.display_name !== "string"
      ) {
        throw providerUnavailable(
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
    if (request.promptCacheMode !== undefined) {
      throw new Error(
        "prompt cache mode controls are not supported by openai-codex; omit promptCacheMode to use the subscription backend's implicit prompt cache",
      );
    }
    if (request.nativeModelToolIds.length > 0) {
      throw new Error(
        "openai-codex does not support provider-native tools in this release",
      );
    }
    // Accepting this silently would make a user-supplied control look
    // effective while nothing sends `context_management` on this path.
    if (
      request.compactThreshold !== undefined && request.compactThreshold > 0
    ) {
      throw new Error(
        "openai-codex does not support server-side compaction in this release",
      );
    }
    if (request.signal?.aborted) throw abortReason(request.signal);
    const converted = await toResponsesInput(
      request.transcript,
      request.model,
      OPENAI_CODEX_PROVIDER_ID,
      OPENAI_CODEX_RESPONSES_LABEL,
      "You are a helpful assistant.",
    );
    if (request.signal?.aborted) throw abortReason(request.signal);
    const credential = await this.#resolver.resolve(request.signal);
    if (request.signal?.aborted) throw abortReason(request.signal);
    const responseTools = toResponsesTools(request.tools);
    const affinityKey = providerRunAffinityKey(
      request.cacheAffinityKey ?? request.runId,
    );
    const requestId = crypto.randomUUID();
    const body = JSON.stringify({
      model: request.model,
      store: false,
      stream: true,
      instructions: converted.instructions,
      input: converted.input,
      ...(responseTools.length > 0 ? { tools: responseTools } : {}),
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: affinityKey,
      ...(request.reasoningEffort !== undefined
        ? { reasoning: { effort: request.reasoningEffort } }
        : {}),
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    const startedAt = this.#now();
    const startedAtMs = performance.now();
    let response: Response;
    try {
      response = await this.#fetchFn(this.#endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "chatgpt-account-id": credential.accountId,
          originator: "cf-harness",
          "User-Agent": "cf-harness",
          "OpenAI-Beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
          "session-id": affinityKey,
          "x-client-request-id": requestId,
        },
        body,
        signal: request.signal,
      });
      if (request.signal?.aborted) {
        await response.body?.cancel(request.signal.reason).catch(() => {});
        throw abortReason(request.signal);
      }
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
      if (request.signal?.aborted) throw abortReason(request.signal);
      throw providerUnavailable("OpenAI Codex transport request failed");
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
      let responseBodyBytes: number | undefined;
      try {
        responseBodyBytes = textBytes(await response.text());
      } catch {
        if (request.signal?.aborted) throw abortReason(request.signal);
      }
      await emitAttempt(request.onAttempt, {
        ...baseAttempt,
        ...(responseBodyBytes !== undefined ? { responseBodyBytes } : {}),
      });
      if (response.status === 429) {
        throw providerUnavailable("OpenAI Codex usage limit reached");
      }
      if (response.status === 401 || response.status === 403) {
        throw providerAuthRequired(
          "OpenAI Codex authentication is no longer accepted",
        );
      }
      throw providerUnavailable(
        `OpenAI Codex Responses request failed (${response.status})`,
      );
    }
    await emitAttempt(request.onAttempt, baseAttempt);
    let terminal: Record<string, unknown> | undefined;
    // The ChatGPT Codex backend streams each completed output item via a
    // `response.output_item.done` event, but with `store: false` it returns an
    // EMPTY `output` array on the terminal `response.completed` event (it does
    // not assemble a stored response to echo back). Accumulate the streamed
    // items so the model's message and tool calls are not silently dropped.
    const streamedItems: unknown[] = [];
    for await (const event of parseSse(response, request.signal)) {
      const type = event.type;
      if (type === "response.output_item.done" && event.item !== undefined) {
        streamedItems.push(event.item);
      }
      if (type === "error") {
        throw providerUnavailable(
          "OpenAI Codex Responses stream returned an error event",
        );
      }
      if (
        type === "response.completed" || type === "response.done" ||
        type === "response.incomplete" || type === "response.failed"
      ) {
        if (
          typeof event.response !== "object" || event.response === null ||
          Array.isArray(event.response)
        ) {
          throw providerUnavailable(
            "Codex Responses terminal event did not include a response object",
          );
        }
        terminal = event.response as Record<string, unknown>;
        break;
      }
    }
    if (!terminal) {
      throw providerUnavailable(
        "Codex Responses stream ended without a terminal response event",
      );
    }
    // With `store: false` the ChatGPT Codex backend returns no assembled output
    // on the terminal event — an empty array, or (also observed on this
    // backend) `null` — even though it streamed the items. Fall back to what we
    // accumulated so downstream parsing sees the model's message and tool
    // calls. A POPULATED terminal output always wins (no double-counting); any
    // other malformed shape is left for normalizeTerminalResponse to reject.
    const terminalOutputEmpty = terminal.output === null ||
      terminal.output === undefined ||
      (Array.isArray(terminal.output) && terminal.output.length === 0);
    if (terminalOutputEmpty && streamedItems.length > 0) {
      terminal = { ...terminal, output: streamedItems };
    }
    const rawUsage = typeof terminal.usage === "object" &&
        terminal.usage !== null && !Array.isArray(terminal.usage)
      ? terminal.usage as Record<string, unknown>
      : undefined;
    const normalizedUsage = normalizeOpenAIUsage(rawUsage);
    const usage = normalizedUsage === undefined ? undefined : {
      ...normalizedUsage,
      estimateWithheldReason: "provider-pricing-unavailable" as const,
    };
    let assistant: ReturnType<typeof normalizeTerminalResponse>;
    try {
      assistant = normalizeTerminalResponse(
        terminal,
        request.model,
        OPENAI_CODEX_PROVIDER_ID,
        OPENAI_CODEX_RESPONSES_LABEL,
      );
    } catch {
      throw providerUnavailable(
        "OpenAI Codex returned an invalid terminal response",
      );
    }
    return {
      assistant,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

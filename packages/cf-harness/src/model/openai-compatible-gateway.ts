import {
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  type LLMNativeModelToolId,
} from "@commonfabric/llm/types";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessNativeModelToolResult,
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import {
  type OpenAIChatCompletionAttemptDiagnostic,
  type OpenAIChatCompletionMessage,
  type OpenAIChatCompletionRequest,
  type OpenAIChatCompletionRequestTool,
  type OpenAIChatCompletionResponse,
  type OpenAIChatCompletionTool,
  type OpenAIChatMessageContent,
  OpenAICompatibleGatewayClient,
  type OpenAIResponsesRequest,
} from "../gateway/openai-client.ts";
import {
  normalizeTerminalResponse,
  providerRunAffinityKey,
  toResponsesInput,
  toResponsesTools,
} from "./responses-protocol.ts";
import { materializeImageAttachmentContentPart } from "../image-attachments.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelCatalogEntry,
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "./client.ts";

const normalizeTextContent = (
  content: OpenAIChatMessageContent | undefined,
): string => {
  if (typeof content === "string") return content;
  // Vertex-backed models omit `content` entirely on tool-call-only turns
  // (gemini-3.5-flash returns just role/thinking_blocks/tool_calls), so this
  // has to treat "absent" the same as "null" rather than assume an array.
  if (content === null || content === undefined) return "";
  return content.flatMap((part) =>
    typeof part === "object" && part !== null && part.type === "text" &&
      typeof part.text === "string"
      ? [part.text]
      : []
  ).join("");
};

export const toOpenAIChatMessage = async (
  message: HarnessTranscriptMessage,
): Promise<OpenAIChatCompletionMessage> => {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      if (!message.imageAttachments?.length) {
        return { role: "user", content: message.content };
      }
      return {
        role: "user",
        content: [
          ...(message.content.length > 0
            ? [{ type: "text" as const, text: message.content }]
            : []),
          ...(await Promise.all(
            message.imageAttachments.map(materializeImageAttachmentContentPart),
          )),
        ],
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls
          ? { tool_calls: message.toolCalls.map((call) => ({ ...call })) }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
  }
};

const toNativeModelTools = (
  ids: readonly LLMNativeModelToolId[],
): OpenAIChatCompletionRequestTool[] => ids.map((id) => ({ type: id }));

const createAssistantMessage = (
  response: OpenAIChatCompletionResponse,
): HarnessAssistantTranscriptMessage => {
  const message = response.choices[0]?.message;
  if (!message) {
    throw new Error(
      "chat completion response did not include a message choice",
    );
  }
  const toolCalls: HarnessToolCall[] | undefined = message.tool_calls?.map(
    (call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }),
  );
  const nativeResults: HarnessNativeModelToolResult[] = [
    ...(response.native_model_tool_results?.map((result) => ({
      type: "cf-harness.native-model-tool-result" as const,
      toolId: result.type,
      ...(result.provider !== undefined ? { provider: result.provider } : {}),
      ...(result.providerMetadata !== undefined
        ? { providerMetadata: result.providerMetadata }
        : {}),
      ...(result.sources !== undefined ? { sources: result.sources } : {}),
    })) ?? []),
    ...(message.grounding_metadata === undefined ? [] : [{
      type: "cf-harness.native-model-tool-result" as const,
      toolId: GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
      provider: "google",
      providerMetadata: message.grounding_metadata,
    }]),
  ];
  return {
    role: "assistant",
    content: normalizeTextContent(message.content),
    ...(toolCalls ? { toolCalls } : {}),
    ...(nativeResults.length > 0
      ? { nativeModelToolResults: nativeResults }
      : {}),
  };
};

export const OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID =
  "openai-compatible-gateway";
const GATEWAY_RESPONSES_LABEL = "gateway Responses";

/**
 * Chooses the Responses API over Chat Completions for a turn.
 *
 * OpenAI's reasoning models reject function tools on `/v1/chat/completions`
 * unless reasoning is disabled outright, so every `gpt-*` turn goes to
 * `/v1/responses`, where tools and reasoning coexist.
 *
 * Two cases stay on Chat Completions because Responses cannot serve them:
 * provider-native tools such as `google_search` have no Responses equivalent
 * on this gateway, and non-OpenAI models (Vertex-backed `claude-*`/`gemini-*`)
 * are not translated to the Responses schema — the gateway answers 500. The
 * `web_search` subagent profile is exactly that combination.
 */
export const usesResponsesApi = (
  model: string,
  nativeModelToolIds: readonly LLMNativeModelToolId[],
): boolean => nativeModelToolIds.length === 0 && model.startsWith("gpt-");

const toModelAttempt = (
  attempt: OpenAIChatCompletionAttemptDiagnostic,
): HarnessModelAttemptDiagnostic => ({
  ...attempt,
  type: "cf-harness.model-attempt",
  providerId: OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID,
});

const toUsage = (
  usage: Record<string, unknown> | undefined,
): HarnessModelTurnResult["usage"] | undefined => {
  if (usage === undefined) return undefined;
  const mapped = {
    ...(typeof usage.input_tokens === "number"
      ? { inputTokens: usage.input_tokens }
      : {}),
    ...(typeof usage.output_tokens === "number"
      ? { outputTokens: usage.output_tokens }
      : {}),
    ...(typeof usage.total_tokens === "number"
      ? { totalTokens: usage.total_tokens }
      : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
};

export class OpenAICompatibleGatewayModelClient implements HarnessModelClient {
  readonly providerId = OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID;

  constructor(readonly gatewayClient: OpenAICompatibleGatewayClient) {}

  async complete(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    return usesResponsesApi(request.model, request.nativeModelToolIds)
      ? await this.#completeViaResponses(request)
      : await this.#completeViaChatCompletions(request);
  }

  async #completeViaChatCompletions(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    const tools: OpenAIChatCompletionTool[] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.toolId,
        description: tool.description,
        parameters: typeof tool.inputSchema === "boolean"
          ? tool.inputSchema
          : { ...tool.inputSchema },
      },
    }));
    const payload: OpenAIChatCompletionRequest = {
      model: request.model,
      messages: await Promise.all(request.transcript.map(toOpenAIChatMessage)),
      tools: [...tools, ...toNativeModelTools(request.nativeModelToolIds)],
      tool_choice: "auto",
    };
    const response = await this.gatewayClient.createChatCompletionJson(
      payload,
      {
        signal: request.signal,
        onChatCompletionAttempt: async (attempt) => {
          await request.onAttempt?.(toModelAttempt(attempt));
        },
      },
    );
    return { assistant: createAssistantMessage(response) };
  }

  async #completeViaResponses(
    request: HarnessModelTurnRequest,
  ): Promise<HarnessModelTurnResult> {
    const converted = await toResponsesInput(
      request.transcript,
      request.model,
      this.providerId,
      GATEWAY_RESPONSES_LABEL,
    );
    const tools = toResponsesTools(request.tools);
    const payload: OpenAIResponsesRequest = {
      model: request.model,
      store: false,
      ...(converted.instructions !== undefined
        ? { instructions: converted.instructions }
        : {}),
      input: converted.input,
      ...(tools.length > 0 ? { tools } : {}),
      tool_choice: "auto",
      parallel_tool_calls: true,
      // Reasoning items are only replayable across turns when the provider
      // returns them encrypted, which `store: false` requires.
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: providerRunAffinityKey(request.runId),
    };
    const response = await this.gatewayClient.createResponseJson(
      payload,
      {
        signal: request.signal,
        onChatCompletionAttempt: async (attempt) => {
          await request.onAttempt?.(toModelAttempt(attempt));
        },
      },
    );
    const usage = toUsage(response.usage);
    return {
      assistant: normalizeTerminalResponse(
        response as unknown as Record<string, unknown>,
        request.model,
        this.providerId,
        GATEWAY_RESPONSES_LABEL,
      ),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  async listModels(
    signal?: AbortSignal,
  ): Promise<readonly HarnessModelCatalogEntry[]> {
    const response = await this.gatewayClient.listModels(signal);
    if (!response.ok) {
      throw new Error(`model list request failed (${response.status})`);
    }
    const json = await response.json() as {
      data?: Array<{ id?: unknown; capabilities?: Record<string, unknown> }>;
    };
    return (json.data ?? []).flatMap((item) =>
      typeof item.id === "string"
        ? [{
          id: item.id,
          displayName: item.id,
          inputModalities: item.capabilities?.images === true
            ? ["text", "image"]
            : ["text"],
          supportedReasoningEfforts: [],
          supportsParallelToolCalls: false,
        }]
        : []
    );
  }
}

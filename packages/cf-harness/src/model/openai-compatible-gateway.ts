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
} from "../gateway/openai-client.ts";
import { materializeImageAttachmentContentPart } from "../image-attachments.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelCatalogEntry,
  HarnessModelClient,
  HarnessModelTurnRequest,
  HarnessModelTurnResult,
} from "./client.ts";

const normalizeTextContent = (content: OpenAIChatMessageContent): string => {
  if (typeof content === "string") return content;
  if (content === null) return "";
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

const toModelAttempt = (
  attempt: OpenAIChatCompletionAttemptDiagnostic,
): HarnessModelAttemptDiagnostic => ({
  ...attempt,
  type: "cf-harness.model-attempt",
  providerId: "openai-compatible-gateway",
});

export class OpenAICompatibleGatewayModelClient implements HarnessModelClient {
  readonly providerId = "openai-compatible-gateway";

  constructor(readonly gatewayClient: OpenAICompatibleGatewayClient) {}

  async complete(
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

  async listModels(
    signal?: AbortSignal,
  ): Promise<readonly HarnessModelCatalogEntry[]> {
    const response = await this.gatewayClient.listModels(signal);
    if (!response.ok) {
      throw new Error(`model list request failed (${response.status})`);
    }
    const json = await response.json() as { data?: Array<{ id?: unknown }> };
    return (json.data ?? []).flatMap((item) =>
      typeof item.id === "string"
        ? [{
          id: item.id,
          displayName: item.id,
          inputModalities: [],
          supportedReasoningEfforts: [],
          supportsParallelToolCalls: false,
        }]
        : []
    );
  }
}

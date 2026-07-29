import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessProviderContinuation,
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import { materializeImageAttachmentContentPart } from "../image-attachments.ts";
import { sha256 } from "@commonfabric/content-hash";
import { encodeHex } from "@std/encoding/hex";

/**
 * Shared OpenAI Responses API wire mapping.
 *
 * Both the Codex client (owner-authenticated, pinned chatgpt.com endpoint) and
 * the OpenAI-compatible gateway client speak this protocol, so the transcript
 * conversion and terminal-response normalization live here. Provider-specific
 * pieces stay with each client: transport, auth, and streaming vs single-shot.
 *
 * `providerId` scopes continuation state so one provider never replays another
 * provider's reasoning items; `label` keeps error text in the caller's voice.
 */
export type ResponsesInputItem = Record<string, unknown>;

const MAX_PROVIDER_AFFINITY_KEY_LENGTH = 64;

/**
 * Bounds a run id for use as `prompt_cache_key`, which the provider caps at 64
 * characters and rejects outright above it.
 *
 * Subagent run ids are derived as `<parent>.subagent.<n>`, so they grow with
 * nesting depth and reach the cap on their own. Long ids keep a readable
 * prefix and a digest suffix so cache affinity stays stable per run.
 */
export const providerRunAffinityKey = (runId: string): string => {
  if (runId.length <= MAX_PROVIDER_AFFINITY_KEY_LENGTH) return runId;
  const digest = encodeHex(sha256(new TextEncoder().encode(runId))).slice(
    0,
    40,
  );
  const prefixLength = MAX_PROVIDER_AFFINITY_KEY_LENGTH - digest.length - 1;
  return `${runId.slice(0, prefixLength)}-${digest}`;
};

/**
 * What to do when a stored continuation was produced by a different model.
 *
 * The encrypted reasoning is bound to the model that produced it, so it can
 * never be replayed to another one. Providers differ on whether that is fatal:
 * Codex pins the provider on resume and treats a mismatch as a caller error,
 * while the gateway lets `--resume-run X --model other` change models, where
 * the reasoning is optional and dropping it just costs continuity.
 */
export type ContinuationModelMismatch = "throw" | "drop";

export const continuationOutput = (
  continuation: HarnessProviderContinuation | undefined,
  model: string,
  providerId: string,
  onModelMismatch: ContinuationModelMismatch = "throw",
): ResponsesInputItem[] => {
  if (continuation?.providerId !== providerId) return [];
  const state = continuation.state;
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return [];
  }
  const record = state as Record<string, unknown>;
  if (record.version !== 1 || typeof record.sourceModel !== "string") return [];
  if (record.sourceModel !== model) {
    if (onModelMismatch === "throw") {
      throw new Error(
        `${providerId} continuation model ${record.sourceModel} does not match requested model ${model}`,
      );
    }
    return [];
  }
  const output = record.output;
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

export const continuationFunctionCallItemId = (
  continuation: HarnessProviderContinuation | undefined,
  callId: string,
  model: string,
  providerId: string,
): string | undefined => {
  if (
    continuation?.providerId !== providerId ||
    typeof continuation.state !== "object" || continuation.state === null ||
    Array.isArray(continuation.state)
  ) return undefined;
  const record = continuation.state as Record<string, unknown>;
  if (record.version !== 1 || record.sourceModel !== model) return undefined;
  const ids = record.functionCallItemIds;
  if (typeof ids !== "object" || ids === null || Array.isArray(ids)) {
    return undefined;
  }
  const itemId = (ids as Record<string, unknown>)[callId];
  return typeof itemId === "string" ? itemId : undefined;
};

export const materializeUserContent = async (
  message: Extract<HarnessTranscriptMessage, { role: "user" }>,
  label: string,
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
        `failed to materialize image attachment for ${label}`,
      );
    }
    content.push({ type: "input_image", detail: "auto", image_url: imageUrl });
  }
  return content;
};

export const toResponsesInput = async (
  transcript: readonly HarnessTranscriptMessage[],
  model: string,
  providerId: string,
  label: string,
  // Used only when the transcript carries no system message. Callers that omit
  // it send no `instructions` at all, so a run without a system prompt is not
  // silently given one.
  defaultInstructions?: string,
  onModelMismatch: ContinuationModelMismatch = "throw",
): Promise<
  { instructions: string | undefined; input: ResponsesInputItem[] }
> => {
  const systemText = transcript.filter((message) => message.role === "system")
    .map((message) => message.content).join("\n\n");
  const instructions = systemText.length > 0 ? systemText : defaultInstructions;
  const input: ResponsesInputItem[] = [];
  for (const [index, message] of transcript.entries()) {
    switch (message.role) {
      case "system":
        break;
      case "user": {
        const content = await materializeUserContent(message, label);
        if (content.length > 0) input.push({ role: "user", content });
        break;
      }
      case "assistant":
        input.push(
          ...continuationOutput(
            message.providerContinuation,
            model,
            providerId,
            onModelMismatch,
          ),
        );
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
            model,
            providerId,
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

export const toResponsesTools = (
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

export const normalizeTerminalResponse = (
  response: Record<string, unknown>,
  sourceModel: string,
  providerId: string,
  label: string,
): HarnessAssistantTranscriptMessage => {
  const status = response.status;
  if (
    status === "incomplete" || status === "failed" || status === "cancelled"
  ) {
    throw new Error(`${label} ended with status ${String(status)}`);
  }
  if (status !== "completed") {
    throw new Error(`${label} terminal event has an unknown status`);
  }
  const output = response.output;
  if (!Array.isArray(output)) {
    throw new Error(`${label} terminal event did not include output`);
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
        } else if (
          content.type === "refusal" && typeof content.refusal === "string"
        ) {
          text.push(content.refusal);
        }
      }
    } else if (item.type === "function_call") {
      if (
        typeof item.call_id !== "string" || typeof item.name !== "string" ||
        typeof item.arguments !== "string"
      ) {
        throw new Error(`${label} included an incomplete tool call`);
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
            `${label} included conflicting duplicate tool-call ids`,
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
          providerId,
          state: {
            version: 1,
            sourceModel,
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

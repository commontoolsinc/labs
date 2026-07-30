import type { LLMNativeModelToolId } from "@commonfabric/llm/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import type { HarnessCredentialOwnerRef } from "../contracts/run-manifest.ts";

export interface HarnessModelRequestSummary {
  model: string;
  messageCount: number;
  toolCount: number;
  nativeModelToolIds?: readonly LLMNativeModelToolId[];
  nativeModelToolCount: number;
  serializedBytes: number;
}

export interface HarnessModelAttemptDiagnostic {
  type: "cf-harness.model-attempt";
  providerId: string;
  operation: string;
  endpoint: string;
  attempt: number;
  maxTransportAttempts: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  request: HarnessModelRequestSummary;
  outcome: "http_response" | "transport_error";
  httpStatus?: number;
  httpStatusText?: string;
  requestId?: string;
  responseHeaders?: Record<string, string>;
  responseBodyBytes?: number;
  responseBodyExcerpt?: string;
  responseBodyTruncated?: boolean;
  errorDetail?: string;
}

export interface HarnessModelTurnRequest {
  model: string;
  transcript: readonly HarnessTranscriptMessage[];
  tools: readonly HarnessToolDescriptor[];
  nativeModelToolIds: readonly LLMNativeModelToolId[];
  runId: string;
  cacheAffinityKey?: string;
  promptCacheMode?: "implicit" | "explicit";
  reasoningEffort?: string;
  signal?: AbortSignal;
  onAttempt?: (
    attempt: HarnessModelAttemptDiagnostic,
  ) => void | Promise<void>;
}

export interface HarnessModelUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /**
   * Provider-reported cost only. The harness does not infer prices when this
   * field is absent.
   */
  costUsd?: number;
  /**
   * Estimate based on the harness pricing table, not a provider invoice.
   */
  estimatedCostUsd?: number;
}

export const HARNESS_MODEL_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
  "estimatedCostUsd",
] as const satisfies readonly (keyof HarnessModelUsage)[];

export interface HarnessModelTurnResult {
  assistant: HarnessAssistantTranscriptMessage;
  usage?: HarnessModelUsage;
}

export interface HarnessModelCatalogEntry {
  id: string;
  displayName: string;
  description?: string;
  inputModalities: readonly string[];
  supportedReasoningEfforts: readonly string[];
  supportsParallelToolCalls: boolean;
}

export interface HarnessModelClient {
  readonly providerId: string;
  /** Exact authenticated owner binding for owner-bound providers. */
  readonly credentialOwner?: HarnessCredentialOwnerRef;
  complete(request: HarnessModelTurnRequest): Promise<HarnessModelTurnResult>;
  listModels?(
    signal?: AbortSignal,
  ): Promise<readonly HarnessModelCatalogEntry[]>;
}

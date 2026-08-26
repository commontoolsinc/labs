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

  /**
   * Overrides the server-side compaction threshold for this turn. Omitted
   * means the client derives it from the model's input budget; `0` disables
   * compaction entirely.
   */
  compactThreshold?: number;
  signal?: AbortSignal;
  onAttempt?: (
    attempt: HarnessModelAttemptDiagnostic,
  ) => void | Promise<void>;
}

export interface HarnessModelUsage {
  inputTokens?: number;

  /** Cache-read tokens included within `inputTokens`, not additional tokens. */
  cachedInputTokens?: number;

  /** Cache-write tokens included within `inputTokens`, not additional tokens. */
  cacheWriteTokens?: number;
  outputTokens?: number;

  /** Reasoning tokens included within `outputTokens`, not additional tokens. */
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

  /**
   * Why `estimatedCostUsd` is absent. Aggregate usage reports
   * `incomplete-estimates` when any included turn lacks an estimate.
   */
  estimateWithheldReason?: HarnessCostEstimateWithheldReason;
}

export type HarnessCostEstimateWithheldReason =
  | "unknown-model"
  | "missing-token-counts"
  | "missing-cache-detail"
  | "invalid-token-counts"
  | "inconsistent-token-counts"
  | "provider-pricing-unavailable"
  | "incomplete-estimates";

export const HARNESS_MODEL_USAGE_NUMERIC_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
  "estimatedCostUsd",
] as const satisfies readonly {
  [K in keyof HarnessModelUsage]: HarnessModelUsage[K] extends
    | number
    | undefined ? K
    : never;
}[keyof HarnessModelUsage][];

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

  /** Total context (input + output) advertised by the registry, when known. */
  contextWindow?: number;

  /** Maximum output tokens; needed to derive the usable input budget. */
  maxOutputTokens?: number;
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

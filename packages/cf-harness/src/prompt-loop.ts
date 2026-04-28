import {
  type BuiltinToolInputMap,
  CfHarnessEngine,
  type CreateHarnessEngineOptions,
} from "./engine.ts";
import {
  type CfcEnforcementMode,
  evaluateHarnessWriteFileAuthorization,
} from "@commonfabric/runner/cfc";
import {
  type OpenAIChatCompletionMessage,
  type OpenAIChatCompletionRequest,
  type OpenAIChatCompletionResponse,
  type OpenAIChatCompletionTool,
  type OpenAIChatMessageContent,
  OpenAICompatibleGatewayClient,
} from "./gateway/openai-client.ts";
import {
  createObservationDenied as makeObservationDenied,
  type ObservationDenied,
} from "./contracts/observation.ts";
import type { PromptSlotBinding } from "./contracts/prompt-slot.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessToolCall,
  HarnessToolTranscriptMessage,
  HarnessTranscriptEvent,
  HarnessTranscriptMessage,
} from "./contracts/transcript.ts";
import type { ToolResultRef } from "./contracts/tool-result.ts";
import type {
  BuiltinToolId,
  HarnessToolDescriptor,
} from "./contracts/tool-descriptor.ts";
import type { HarnessToolInputSummary } from "./contracts/policy.ts";
import {
  createHarnessRunReport,
  type HarnessRunTimelineEntryInput,
  type HarnessToolActivity,
  type HarnessToolPolicyDecision,
} from "./contracts/run-report.ts";
import {
  DEFAULT_SUBAGENT_ALLOWED_TOOL_IDS,
  DEFAULT_SUBAGENT_MAX_MODEL_TURNS,
  DEFAULT_SUBAGENT_PROFILE,
  type DelegateTaskToolInput,
  type DelegateTaskToolOutput,
  type HarnessSubagentFailureSummary,
  type HarnessSubagentInputSummary,
  type HarnessSubagentResult,
  type HarnessSubagentRunManifest,
  type HarnessSubagentRunStateSummary,
  MAX_SUBAGENT_MAX_MODEL_TURNS,
} from "./contracts/subagent.ts";
import { BUILTIN_TOOLS, getBuiltinTool } from "./tools/registry.ts";
import type { HarnessFailureRecord } from "./diagnostics.ts";

const DEFAULT_MAX_MODEL_TURNS = 8;

export interface CreateHarnessPromptLoopOptions
  extends CreateHarnessEngineOptions {
  engine?: CfHarnessEngine;
  gatewayClient?: OpenAICompatibleGatewayClient;
  apiKey?: string;
  apiKeySource?: string;
  fetchFn?: typeof fetch;
  maxModelTurns?: number;
  allowedToolIds?: readonly BuiltinToolId[];
}

export interface RunHarnessPromptOptions {
  prompt: string;
  systemPrompt?: string;
  maxModelTurns?: number;
  model?: string;
  promptSlotBinding?: PromptSlotBinding;
  onTranscriptEvent?: (
    event: HarnessTranscriptEvent,
  ) => void | Promise<void>;
}

export interface RunHarnessTranscriptOptions {
  transcript: readonly HarnessTranscriptMessage[];
  maxModelTurns?: number;
  model?: string;
  promptSlotBinding?: PromptSlotBinding;
  onTranscriptEvent?: (
    event: HarnessTranscriptEvent,
  ) => void | Promise<void>;
}

export interface HarnessPromptLoopResult {
  model: string;
  finalAssistantText: string;
  transcript: HarnessTranscriptMessage[];
  modelTurns: number;
  runState: ReturnType<CfHarnessEngine["getRunState"]>;
}

const isBuiltinToolId = (input: string): input is BuiltinToolId =>
  getBuiltinTool(input as BuiltinToolId) !== undefined;

const normalizeTextContent = (content: OpenAIChatMessageContent): string => {
  if (typeof content === "string") {
    return content;
  }
  if (content === null) {
    return "";
  }
  return content
    .flatMap((part) =>
      typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
        ? [part.text]
        : []
    )
    .join("");
};

const toOpenAIChatMessage = (
  message: HarnessTranscriptMessage,
): OpenAIChatCompletionMessage => {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls !== undefined
          ? {
            tool_calls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
          }
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

const toOpenAITools = (
  allowedToolIds?: ReadonlySet<BuiltinToolId>,
): OpenAIChatCompletionTool[] =>
  BUILTIN_TOOLS.filter((tool) =>
    allowedToolIds === undefined ||
    allowedToolIds.has(tool.descriptor.toolId)
  ).map((tool) => ({
    type: "function",
    function: {
      name: tool.descriptor.toolId,
      description: tool.descriptor.description,
      parameters: typeof tool.descriptor.inputSchema === "boolean"
        ? tool.descriptor.inputSchema
        : { ...tool.descriptor.inputSchema },
    },
  }));

const parseToolArguments = (
  toolCall: HarnessToolCall,
): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    throw new Error(
      `failed to parse tool arguments for ${toolCall.function.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `tool arguments for ${toolCall.function.name} must decode to an object`,
    );
  }
  return parsed as Record<string, unknown>;
};

const tryParseToolArguments = (
  toolCall: HarnessToolCall,
): Record<string, unknown> | undefined => {
  try {
    return parseToolArguments(toolCall);
  } catch {
    return undefined;
  }
};

const textBytes = (input: string): Uint8Array =>
  new TextEncoder().encode(input);

const sha256Digest = async (input: Uint8Array): Promise<string> => {
  const digestInput = input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const summarizeSensitiveText = async (
  input: string,
): Promise<{ bytes: number; digest: string }> => {
  const bytes = textBytes(input);
  return {
    bytes: bytes.byteLength,
    digest: await sha256Digest(bytes),
  };
};

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const optionalPolicyEventIndexes = (
  policyEventIndexes: readonly number[],
): { policyEventIndexes?: number[] } =>
  policyEventIndexes.length > 0
    ? { policyEventIndexes: [...policyEventIndexes] }
    : {};

const transcriptTimelineEntry = (
  message: HarnessTranscriptMessage,
  transcriptIndex: number,
  at: string,
  modelTurn?: number,
): HarnessRunTimelineEntryInput => ({
  kind: "transcript_message",
  at,
  transcriptIndex,
  role: message.role,
  ...(modelTurn !== undefined ? { modelTurn } : {}),
  ...(message.role === "assistant" && message.toolCalls !== undefined
    ? { toolCallIds: message.toolCalls.map((toolCall) => toolCall.id) }
    : {}),
  ...(message.role === "tool"
    ? { toolCallId: message.toolCallId, toolId: message.toolName }
    : {}),
});

const toErrorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const PROMPT_LOOP_MODEL_TURNS = Symbol("cf-harness.prompt-loop.model-turns");

interface PromptLoopErrorWithModelTurns {
  [PROMPT_LOOP_MODEL_TURNS]?: number;
}

const annotatePromptLoopError = (
  error: unknown,
  modelTurns: number,
): void => {
  if (typeof error !== "object" || error === null) {
    return;
  }
  try {
    Object.defineProperty(error, PROMPT_LOOP_MODEL_TURNS, {
      value: modelTurns,
      configurable: true,
    });
  } catch {
    // Some thrown objects may be non-extensible; best-effort metadata only.
  }
};

const promptLoopModelTurnsFromError = (
  error: unknown,
): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const modelTurns = (error as PromptLoopErrorWithModelTurns)[
    PROMPT_LOOP_MODEL_TURNS
  ];
  return isSafeNonNegativeInteger(modelTurns) ? modelTurns : undefined;
};

const childRunSequenceFromId = (
  parentRunId: string,
  childRunId: string,
): number | undefined => {
  const prefix = `${parentRunId}.subagent.`;
  if (!childRunId.startsWith(prefix)) {
    return undefined;
  }
  const sequenceText = childRunId.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(sequenceText)) {
    return undefined;
  }
  const sequence = Number(sequenceText);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
};

const nextSubagentSequence = (
  runState: ReturnType<CfHarnessEngine["getRunState"]>,
): number => {
  const retainedDelegateOutputs =
    runState.toolOutputs.filter((ref) =>
      ref.runId === runState.runId && ref.toolId === "delegate_task"
    ).length;
  const retainedChildRunSequence = Math.max(
    0,
    ...(runState.subagentRuns ?? []).flatMap((run) => {
      const sequence = childRunSequenceFromId(
        runState.runId,
        run.childRunId,
      );
      return sequence === undefined ? [] : [sequence];
    }),
  );
  return Math.max(retainedDelegateOutputs, retainedChildRunSequence) + 1;
};

const summarizeSubagentFailure = (
  failure: HarnessFailureRecord,
): HarnessSubagentFailureSummary => ({
  type: "cf-harness.subagent-failure-summary",
  kind: failure.kind,
  source: failure.source,
  ...(failure.toolId !== undefined ? { toolId: failure.toolId } : {}),
  ...(failure.toolCallId !== undefined
    ? { toolCallId: failure.toolCallId }
    : {}),
  ...(failure.outputId !== undefined ? { outputId: failure.outputId } : {}),
  ...(failure.commandName !== undefined
    ? { commandName: failure.commandName }
    : {}),
  ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
});

const summarizeToolInput = async (
  toolId: BuiltinToolId,
  input: Record<string, unknown>,
): Promise<HarnessToolInputSummary> => {
  switch (toolId) {
    case "bash": {
      const commandSummary = typeof input.command === "string"
        ? await summarizeSensitiveText(input.command)
        : undefined;
      return {
        type: "cf-harness.tool-input-summary",
        toolId,
        ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
        ...(isSafeNonNegativeInteger(input.timeoutMs)
          ? { timeoutMs: input.timeoutMs }
          : {}),
        ...(commandSummary !== undefined
          ? {
            commandBytes: commandSummary.bytes,
            commandDigest: commandSummary.digest,
          }
          : {}),
      };
    }
    case "read_file":
      return {
        type: "cf-harness.tool-input-summary",
        toolId,
        ...(typeof input.path === "string" ? { path: input.path } : {}),
        ...(isSafeNonNegativeInteger(input.maxBytes)
          ? { maxBytes: input.maxBytes }
          : {}),
      };
    case "write_file": {
      const contentSummary = typeof input.content === "string"
        ? await summarizeSensitiveText(input.content)
        : undefined;
      const mode = input.mode === "append" || input.mode === "replace"
        ? input.mode
        : input.mode === undefined
        ? "replace"
        : undefined;
      return {
        type: "cf-harness.tool-input-summary",
        toolId,
        ...(typeof input.path === "string" ? { path: input.path } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(typeof input.createParents === "boolean"
          ? { createParents: input.createParents }
          : {}),
        ...(contentSummary !== undefined
          ? {
            contentBytes: contentSummary.bytes,
            contentDigest: contentSummary.digest,
          }
          : {}),
      };
    }
    case "delegate_task": {
      const goalSummary = typeof input.goal === "string"
        ? await summarizeSensitiveText(input.goal)
        : undefined;
      const contextSummary = typeof input.context === "string"
        ? await summarizeSensitiveText(input.context)
        : undefined;
      return {
        type: "cf-harness.tool-input-summary",
        toolId,
        ...(goalSummary !== undefined
          ? {
            goalBytes: goalSummary.bytes,
            goalDigest: goalSummary.digest,
          }
          : {}),
        ...(contextSummary !== undefined
          ? {
            contextBytes: contextSummary.bytes,
            contextDigest: contextSummary.digest,
          }
          : {}),
        ...(isSafeNonNegativeInteger(input.maxModelTurns)
          ? { maxModelTurns: input.maxModelTurns }
          : {}),
      };
    }
  }
  return {
    type: "cf-harness.tool-input-summary",
    toolId,
  };
};

const parseDelegateTaskInput = (
  input: Record<string, unknown>,
): DelegateTaskToolInput => {
  if (typeof input.goal !== "string" || input.goal.trim().length === 0) {
    throw new Error("delegate_task goal must be a non-empty string");
  }
  if (input.context !== undefined && typeof input.context !== "string") {
    throw new Error("delegate_task context must be a string when provided");
  }
  const maxModelTurns = input.maxModelTurns;
  if (
    maxModelTurns !== undefined &&
    (typeof maxModelTurns !== "number" ||
      !Number.isSafeInteger(maxModelTurns) ||
      maxModelTurns <= 0 ||
      maxModelTurns > MAX_SUBAGENT_MAX_MODEL_TURNS)
  ) {
    throw new Error(
      `delegate_task maxModelTurns must be an integer from 1 to ${MAX_SUBAGENT_MAX_MODEL_TURNS}`,
    );
  }
  return {
    goal: input.goal,
    ...(typeof input.context === "string" && input.context.trim().length > 0
      ? { context: input.context }
      : {}),
    ...(typeof maxModelTurns === "number" ? { maxModelTurns } : {}),
  };
};

const createSubagentInputSummary = async (
  input: DelegateTaskToolInput,
): Promise<HarnessSubagentInputSummary> => {
  const goalSummary = await summarizeSensitiveText(input.goal);
  const contextSummary = input.context === undefined
    ? undefined
    : await summarizeSensitiveText(input.context);
  return {
    type: "cf-harness.subagent-input-summary",
    goalBytes: goalSummary.bytes,
    goalDigest: goalSummary.digest,
    ...(contextSummary !== undefined
      ? {
        contextBytes: contextSummary.bytes,
        contextDigest: contextSummary.digest,
      }
      : {}),
  };
};

const buildSubagentSystemPrompt = (currentDir: string): string =>
  [
    "You are a focused cf-harness subagent working on one delegated task.",
    "You start with a fresh context and do not know the parent conversation.",
    "Use only the task and context provided in this child run.",
    "Do not ask the user follow-up questions.",
    "Do not attempt to delegate further; nested subagents are not available.",
    `Current sandbox directory: ${currentDir}`,
    "",
    "When finished, return a concise summary with:",
    "- what you did or investigated",
    "- what you found or changed",
    "- files modified, if any",
    "- issues or blockers, if any",
  ].join("\n");

const buildSubagentUserPrompt = (input: DelegateTaskToolInput): string =>
  [
    "Task:",
    input.goal,
    ...(input.context !== undefined ? ["", "Context:", input.context] : []),
  ].join("\n");

const summarizeSubagentRunState = (
  runState: ReturnType<CfHarnessEngine["getRunState"]>,
): HarnessSubagentRunStateSummary => {
  const warnings =
    runState.policyEvents.filter((event) => event.severity === "warning")
      .length;
  const denied =
    runState.policyEvents.filter((event) => event.severity === "denied").length;
  return {
    status: runState.status,
    cfcEnforcementMode: runState.cfcEnforcementMode,
    createdAt: runState.createdAt,
    updatedAt: runState.updatedAt,
    ...(runState.endedAt !== undefined ? { endedAt: runState.endedAt } : {}),
    ...(runState.artifactRoot !== undefined
      ? { artifactRoot: runState.artifactRoot }
      : {}),
    ...(runState.transcriptPath !== undefined
      ? { transcriptPath: runState.transcriptPath }
      : {}),
    ...(runState.runReportPath !== undefined
      ? { runReportPath: runState.runReportPath }
      : {}),
    ...(runState.terminalReason !== undefined
      ? { terminalReason: runState.terminalReason }
      : {}),
    policyEventCounts: {
      total: runState.policyEvents.length,
      warnings,
      denied,
    },
    failureCount: runState.failureRecords?.length ?? 0,
    ...(runState.primaryFailure !== undefined
      ? { primaryFailure: summarizeSubagentFailure(runState.primaryFailure) }
      : {}),
  };
};

const createAssistantTranscriptMessage = (
  response: OpenAIChatCompletionResponse,
): HarnessAssistantTranscriptMessage => {
  const message = response.choices[0]?.message;
  if (message === undefined) {
    throw new Error(
      "chat completion response did not include a message choice",
    );
  }
  const toolCalls: HarnessToolCall[] | undefined = message.tool_calls?.map((
    toolCall,
  ) => ({
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  }));
  return {
    role: "assistant",
    content: normalizeTextContent(message.content),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
};

interface ToolPolicyDecision {
  allowed: boolean;
  warningDetail?: string;
  denial?: ObservationDenied;
}

const hasDirectCommandBinding = (
  promptSlotBinding?: PromptSlotBinding,
): boolean => promptSlotBinding?.role === "direct-command";

const evaluateToolPolicy = (
  cfcEnforcementMode: CfcEnforcementMode,
  descriptor: HarnessToolDescriptor,
  promptSlotBinding?: PromptSlotBinding,
  input?: Record<string, unknown>,
): ToolPolicyDecision => {
  const directCommand = hasDirectCommandBinding(promptSlotBinding);
  if (descriptor.toolId === "write_file") {
    const decision = evaluateHarnessWriteFileAuthorization({
      enforcementMode: cfcEnforcementMode,
      promptSlot: promptSlotBinding === undefined ? undefined : {
        role: promptSlotBinding.role,
        surface: promptSlotBinding.surface,
        subject: promptSlotBinding.subject,
        eventId: promptSlotBinding.eventId,
      },
      path: typeof input?.path === "string" ? input.path : "unknown",
      mode: input?.mode === "append" ? "append" : "replace",
    });
    return decision.allowed
      ? {
        allowed: true,
        ...(decision.warningDetail !== undefined
          ? { warningDetail: decision.warningDetail }
          : {}),
      }
      : {
        allowed: false,
        denial: makeObservationDenied("not-authorized", {
          detail: decision.denialDetail ?? "write_file was denied",
        }),
      };
  }
  switch (cfcEnforcementMode) {
    case "disabled":
      return { allowed: true };
    case "observe":
      if (!directCommand && descriptor.effectClass !== "read") {
        return {
          allowed: true,
          warningDetail:
            `${descriptor.toolId} would require direct-command authorization in enforce modes`,
        };
      }
      return { allowed: true };
    case "enforce-explicit":
      if (descriptor.effectClass === "read" || directCommand) {
        return { allowed: true };
      }
      return {
        allowed: false,
        denial: makeObservationDenied("not-authorized", {
          detail:
            `${descriptor.toolId} requires direct-command authorization in enforce-explicit`,
        }),
      };
    case "enforce-strict":
      if (directCommand) {
        return { allowed: true };
      }
      return {
        allowed: false,
        denial: makeObservationDenied("not-authorized", {
          detail:
            `${descriptor.toolId} requires direct-command authorization in enforce-strict`,
        }),
      };
  }
};

export class CfHarnessPromptLoop {
  readonly engine: CfHarnessEngine;
  readonly gatewayClient: OpenAICompatibleGatewayClient;
  readonly #maxModelTurns: number;
  readonly #allowedToolIds?: ReadonlySet<BuiltinToolId>;

  constructor(options: CreateHarnessPromptLoopOptions = {}) {
    this.engine = options.engine ?? new CfHarnessEngine(options);
    this.gatewayClient = options.gatewayClient ??
      new OpenAICompatibleGatewayClient({
        baseUrl: this.engine.config.gatewayBaseUrl,
        authMode: this.engine.config.gatewayAuthMode,
        apiKey: options.apiKey,
        apiKeySource: options.apiKeySource,
        fetchFn: options.fetchFn,
      });
    this.#maxModelTurns = options.maxModelTurns ?? DEFAULT_MAX_MODEL_TURNS;
    this.#allowedToolIds = options.allowedToolIds === undefined
      ? undefined
      : new Set(options.allowedToolIds);
  }

  async runPrompt(
    options: RunHarnessPromptOptions,
  ): Promise<HarnessPromptLoopResult> {
    return await this.runTranscript({
      transcript: [
        ...(options.systemPrompt !== undefined
          ? [{ role: "system", content: options.systemPrompt } as const]
          : []),
        { role: "user", content: options.prompt },
      ],
      model: options.model,
      maxModelTurns: options.maxModelTurns,
      promptSlotBinding: options.promptSlotBinding,
      onTranscriptEvent: options.onTranscriptEvent,
    });
  }

  async runTranscript(
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> {
    const initialRunState = this.engine.getRunState();
    const model = options.model ?? initialRunState.model ??
      this.engine.config.model;
    const promptSlotBinding = options.promptSlotBinding ??
      initialRunState.promptSlotBinding;
    if (model === undefined) {
      throw new Error(
        "a model must be configured before running the prompt loop",
      );
    }
    const transcript: HarnessTranscriptMessage[] = [...options.transcript];
    const maxModelTurns = options.maxModelTurns ?? this.#maxModelTurns;
    const toolActivity: HarnessToolActivity[] = [];
    const reportTimeline: HarnessRunTimelineEntryInput[] = [];
    let modelTurns = 0;
    const persistRunReport = async (
      finalAssistantText?: string,
    ): Promise<void> => {
      await this.engine.persistRunReport(
        createHarnessRunReport({
          runState: this.engine.getRunState(),
          model,
          modelTurns,
          ...(finalAssistantText !== undefined ? { finalAssistantText } : {}),
          timeline: reportTimeline,
          toolActivity,
        }),
      );
    };
    await this.engine.ensureDiagnosticsInitialized();
    this.engine.setRunStatus("running");
    if (options.promptSlotBinding !== undefined) {
      this.engine.setPromptSlotBinding(options.promptSlotBinding);
    }
    await this.engine.persistRunState();
    await this.engine.persistTranscript(transcript);
    const initialTranscriptAt = this.engine.getRunState().updatedAt;
    for (const [index, message] of transcript.entries()) {
      reportTimeline.push(transcriptTimelineEntry(
        message,
        index,
        initialTranscriptAt,
      ));
    }
    for (const message of transcript) {
      await options.onTranscriptEvent?.({ message, transcript });
    }
    try {
      while (modelTurns < maxModelTurns) {
        modelTurns += 1;
        const response = await this.gatewayClient.createChatCompletionJson(
          this.#buildChatCompletionRequest(model, transcript),
        );
        const assistantMessage = createAssistantTranscriptMessage(response);
        transcript.push(assistantMessage);
        await this.engine.persistTranscript(transcript);
        reportTimeline.push(transcriptTimelineEntry(
          assistantMessage,
          transcript.length - 1,
          this.engine.getRunState().updatedAt,
          modelTurns,
        ));
        await options.onTranscriptEvent?.({
          message: assistantMessage,
          transcript,
        });
        const toolCalls = assistantMessage.toolCalls ?? [];
        if (toolCalls.length === 0) {
          this.engine.setRunStatus("completed", "assistant_completed");
          await this.engine.persistRunState();
          await persistRunReport(assistantMessage.content);
          return {
            model,
            finalAssistantText: assistantMessage.content,
            transcript,
            modelTurns,
            runState: this.engine.getRunState(),
          };
        }
        for (const toolCall of toolCalls) {
          const toolMessage = await this.#invokeToolCall(
            toolCall,
            model,
            promptSlotBinding,
            toolActivity.length + 1,
            (activity) => toolActivity.push(activity),
          );
          transcript.push(toolMessage);
          await this.engine.persistTranscript(transcript);
          reportTimeline.push(transcriptTimelineEntry(
            toolMessage,
            transcript.length - 1,
            this.engine.getRunState().updatedAt,
            modelTurns,
          ));
          await options.onTranscriptEvent?.({
            message: toolMessage,
            transcript,
          });
        }
      }
    } catch (error) {
      annotatePromptLoopError(error, modelTurns);
      this.engine.appendFailureFromError(error);
      this.engine.setRunStatus("failed", "prompt_loop_error");
      try {
        await this.engine.persistRunState();
        await this.engine.persistTranscript(transcript);
        await persistRunReport();
      } catch {
        // Preserve the original model/tool failure when cleanup persistence also fails.
      }
      throw error;
    }
    const turnLimitError = new Error(
      `prompt loop exceeded max model turns (${maxModelTurns}) without a final assistant response`,
    );
    annotatePromptLoopError(turnLimitError, modelTurns);
    this.engine.appendFailureFromError(turnLimitError);
    this.engine.setRunStatus("failed", "max_model_turns");
    await this.engine.persistRunState();
    await this.engine.persistTranscript(transcript);
    await persistRunReport();
    throw turnLimitError;
  }

  #buildChatCompletionRequest(
    model: string,
    transcript: readonly HarnessTranscriptMessage[],
  ): OpenAIChatCompletionRequest {
    return {
      model,
      messages: transcript.map(toOpenAIChatMessage),
      tools: toOpenAITools(this.#allowedToolIds),
      tool_choice: "auto",
    };
  }

  async #invokeToolCall(
    toolCall: HarnessToolCall,
    model: string,
    promptSlotBinding?: PromptSlotBinding,
    sequence = 1,
    recordActivity: (activity: HarnessToolActivity) => void = () => {},
  ): Promise<HarnessToolTranscriptMessage> {
    if (!isBuiltinToolId(toolCall.function.name)) {
      throw new Error(
        `unknown builtin tool requested: ${toolCall.function.name}`,
      );
    }
    const tool = getBuiltinTool(toolCall.function.name);
    if (tool === undefined) {
      throw new Error(
        `unknown builtin tool requested: ${toolCall.function.name}`,
      );
    }
    const parsedInputForDeniedTool = tryParseToolArguments(toolCall);
    const deniedToolInputSummary = parsedInputForDeniedTool === undefined
      ? undefined
      : await summarizeToolInput(
        toolCall.function.name,
        parsedInputForDeniedTool,
      );
    const policyEventIndexes: number[] = [];
    const activityStartedAt = this.engine.getRunState().updatedAt;
    const activityEndedAt = (): string => this.engine.getRunState().updatedAt;
    const baseActivity = (
      policyDecision: HarnessToolPolicyDecision,
      executionStatus: HarnessToolActivity["executionStatus"],
    ): Omit<HarnessToolActivity, "type"> => ({
      runId: this.engine.getRunState().runId,
      sequence,
      startedAt: activityStartedAt,
      endedAt: activityEndedAt(),
      toolCallId: toolCall.id,
      toolId: toolCall.function.name,
      effectClass: tool.descriptor.effectClass,
      cfcEnforcementMode: this.engine.getRunState().cfcEnforcementMode,
      policyDecision,
      executionStatus,
      ...(promptSlotBinding !== undefined
        ? { promptSlot: promptSlotBinding }
        : {}),
    });
    const recordPolicyEvent = async (
      event: Parameters<CfHarnessEngine["recordPolicyEvent"]>[0],
    ): Promise<void> => {
      const index = this.engine.getRunState().policyEvents.length;
      await this.engine.recordPolicyEvent(event);
      policyEventIndexes.push(index);
    };
    if (
      this.#allowedToolIds !== undefined &&
      !this.#allowedToolIds.has(toolCall.function.name)
    ) {
      const denial = makeObservationDenied("not-authorized", {
        detail: `${toolCall.function.name} is not allowed in this run`,
      });
      await recordPolicyEvent({
        severity: "denied",
        mode: this.engine.getRunState().cfcEnforcementMode,
        toolId: toolCall.function.name,
        toolCallId: toolCall.id,
        ...(promptSlotBinding !== undefined
          ? { promptSlot: promptSlotBinding }
          : {}),
        ...(deniedToolInputSummary !== undefined
          ? { toolInputSummary: deniedToolInputSummary }
          : {}),
        detail: denial.detail ?? `${toolCall.function.name} is not allowed`,
        observationDenied: denial,
      });
      recordActivity({
        type: "cf-harness.tool-activity",
        ...baseActivity("denied", "not-run"),
        ...(deniedToolInputSummary !== undefined
          ? { toolInputSummary: deniedToolInputSummary }
          : {}),
        ...optionalPolicyEventIndexes(policyEventIndexes),
      });
      return {
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        content: JSON.stringify(denial),
      };
    }
    const input = parsedInputForDeniedTool ?? parseToolArguments(toolCall);
    const toolInputSummary = deniedToolInputSummary ??
      await summarizeToolInput(toolCall.function.name, input);
    const decision = evaluateToolPolicy(
      this.engine.getRunState().cfcEnforcementMode,
      tool.descriptor,
      promptSlotBinding,
      input,
    );
    let policyDecision: HarnessToolPolicyDecision = "allowed";
    if (decision.warningDetail !== undefined) {
      await recordPolicyEvent({
        severity: "warning",
        mode: this.engine.getRunState().cfcEnforcementMode,
        toolId: toolCall.function.name,
        toolCallId: toolCall.id,
        ...(promptSlotBinding !== undefined
          ? { promptSlot: promptSlotBinding }
          : {}),
        toolInputSummary,
        detail: decision.warningDetail,
      });
      policyDecision = "warned";
    }
    if (!decision.allowed) {
      const denial = decision.denial ??
        makeObservationDenied("not-authorized", {
          detail: `${toolCall.function.name} was denied`,
        });
      await recordPolicyEvent({
        severity: "denied",
        mode: this.engine.getRunState().cfcEnforcementMode,
        toolId: toolCall.function.name,
        toolCallId: toolCall.id,
        ...(promptSlotBinding !== undefined
          ? { promptSlot: promptSlotBinding }
          : {}),
        toolInputSummary,
        detail: denial.detail ?? `${toolCall.function.name} was denied`,
        observationDenied: denial,
      });
      recordActivity({
        type: "cf-harness.tool-activity",
        ...baseActivity("denied", "not-run"),
        toolInputSummary,
        ...optionalPolicyEventIndexes(policyEventIndexes),
      });
      return {
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        content: JSON.stringify(denial),
      };
    }
    let result: {
      output: Awaited<
        ReturnType<CfHarnessEngine["invokeBuiltinTool"]>
      >["output"];
      resultRef: ToolResultRef;
    };
    try {
      result = toolCall.function.name === "delegate_task"
        ? await this.#invokeDelegateTaskTool({
          toolCall,
          input,
          model,
          promptSlotBinding,
          sequence,
        })
        : await this.#invokeBuiltinTool(
          toolCall.function.name,
          input,
        );
    } catch (error) {
      recordActivity({
        type: "cf-harness.tool-activity",
        ...baseActivity(policyDecision, "failed"),
        toolInputSummary,
        ...optionalPolicyEventIndexes(policyEventIndexes),
        errorDetail: toErrorDetail(error),
      });
      throw error;
    }
    recordActivity({
      type: "cf-harness.tool-activity",
      ...baseActivity(policyDecision, "completed"),
      toolInputSummary,
      ...optionalPolicyEventIndexes(policyEventIndexes),
      resultRef: result.resultRef,
    });
    return {
      role: "tool",
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      content: JSON.stringify(result.output),
      resultRef: result.resultRef,
    };
  }

  async #invokeBuiltinTool<TToolId extends BuiltinToolId>(
    toolId: TToolId,
    input: Record<string, unknown>,
  ): Promise<{
    output: Awaited<ReturnType<CfHarnessEngine["invokeBuiltinTool"]>>["output"];
    resultRef: ToolResultRef;
  }> {
    const result = await this.engine.invokeBuiltinTool(
      toolId,
      input as unknown as BuiltinToolInputMap[TToolId],
    );
    return {
      output: result.output,
      resultRef: result.resultRef,
    };
  }

  async #invokeDelegateTaskTool(options: {
    toolCall: HarnessToolCall;
    input: Record<string, unknown>;
    model: string;
    promptSlotBinding?: PromptSlotBinding;
    sequence: number;
  }): Promise<{
    output: DelegateTaskToolOutput;
    resultRef: ToolResultRef;
  }> {
    const delegateInput = parseDelegateTaskInput(options.input);
    const maxModelTurns = delegateInput.maxModelTurns ??
      DEFAULT_SUBAGENT_MAX_MODEL_TURNS;
    const parentRunState = this.engine.getRunState();
    const subagentSequence = nextSubagentSequence(parentRunState);
    const childRunId = `${parentRunState.runId}.subagent.${subagentSequence}`;
    const childEngine = new CfHarnessEngine({
      runId: childRunId,
      sandboxRuntime: this.engine.sandbox,
      artifactRoot: this.engine.artifactStore?.artifactRoot,
      model: options.model,
      gatewayBaseUrl: this.engine.config.gatewayBaseUrl,
      gatewayAuthMode: this.engine.config.gatewayAuthMode,
      cwd: parentRunState.currentDir,
      cfcEnforcementMode: parentRunState.cfcEnforcementMode,
    });
    const childCreatedState = childEngine.getRunState();
    const manifest: HarnessSubagentRunManifest = {
      type: "cf-harness.subagent-run-manifest",
      version: 1,
      parentRunId: parentRunState.runId,
      parentToolCallId: options.toolCall.id,
      childRunId,
      profile: DEFAULT_SUBAGENT_PROFILE,
      depth: 1,
      cfcEnforcementMode: parentRunState.cfcEnforcementMode,
      model: options.model,
      allowedToolIds: [...DEFAULT_SUBAGENT_ALLOWED_TOOL_IDS],
      maxModelTurns,
      createdAt: childCreatedState.createdAt,
      inputSummary: await createSubagentInputSummary(delegateInput),
    };
    const childLoop = new CfHarnessPromptLoop({
      engine: childEngine,
      gatewayClient: this.gatewayClient,
      maxModelTurns,
      allowedToolIds: DEFAULT_SUBAGENT_ALLOWED_TOOL_IDS,
    });
    let subagentStatus: HarnessSubagentResult["status"] = "completed";
    let summary = "";
    let childModelTurns = 0;
    try {
      const childResult = await childLoop.runPrompt({
        systemPrompt: buildSubagentSystemPrompt(
          childEngine.getRunState().currentDir,
        ),
        prompt: buildSubagentUserPrompt(delegateInput),
        model: options.model,
        maxModelTurns,
        promptSlotBinding: options.promptSlotBinding,
      });
      summary = childResult.finalAssistantText;
      childModelTurns = childResult.modelTurns;
      if (childResult.runState.status !== "completed") {
        subagentStatus = "failed";
      }
    } catch (error) {
      subagentStatus = "failed";
      childModelTurns = promptLoopModelTurnsFromError(error) ?? childModelTurns;
      summary = `Subagent failed: ${toErrorDetail(error)}`;
    }
    const childRunState = childEngine.getRunState();
    const subagent: HarnessSubagentResult = {
      type: "cf-harness.subagent-result",
      childRunId,
      status: subagentStatus,
      summary,
      model: options.model,
      modelTurns: childModelTurns,
      runState: summarizeSubagentRunState(childRunState),
      manifest,
    };
    const output: DelegateTaskToolOutput = {
      type: "cf-harness.delegate-task-output",
      outputId: this.engine.nextToolOutputId("delegate_task"),
      subagent,
    };
    const result = await this.engine.recordBuiltinToolOutput(
      "delegate_task",
      delegateInput,
      output,
    );
    await this.engine.recordSubagentRun({
      type: "cf-harness.subagent-run-ref",
      parentToolCallId: options.toolCall.id,
      outputId: output.outputId,
      childRunId,
      status: subagent.status,
      summary: subagent.summary,
      manifest,
      runState: subagent.runState,
    });
    return {
      output: result.output,
      resultRef: result.resultRef,
    };
  }
}

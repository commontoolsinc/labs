import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessImageAttachment } from "./image.ts";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import {
  type BuiltinToolId,
  DEFAULT_PARENT_TOOL_IDS,
} from "./tool-descriptor.ts";
import {
  DEFAULT_SUBAGENT_PROFILE,
  type HarnessSubagentProfile,
} from "./subagent.ts";

export const HARNESS_CHAT_PROTOCOL_VERSION = 1 as const;
export const HARNESS_CHAT_REQUEST_TYPE = "cf-harness.chat.request" as const;
export const HARNESS_CHAT_RESPONSE_TYPE = "cf-harness.chat.response" as const;
export const HARNESS_CHAT_EVENT_TYPE = "cf-harness.chat.event" as const;

export const READONLY_INTERACTIVE_CHAT_TOOL_IDS = [
  "read_file",
  "view_image",
  "read_skill_resource",
] as const satisfies readonly BuiltinToolId[];

export type HarnessChatRequestMethod =
  | "start_session"
  | "start_turn"
  | "cancel_turn"
  | "close_session"
  | "status";

export type HarnessChatSessionLifecycle =
  | "idle"
  | "turn_running"
  | "canceling"
  | "closed"
  | "failed";

export type HarnessChatTurnLifecycle =
  | "running"
  | "canceling"
  | "canceled"
  | "completed"
  | "failed";

export type HarnessChatToolPolicyMode = "workspace-write" | "read-only";

export interface HarnessChatCapabilities {
  partialTextStream: boolean;
  toolTelemetry: boolean;
  fileMutationEvents: boolean;
  browserProfile: boolean;
  browserAccessLease: boolean;
  delegation: boolean;
  readonlyMode: boolean;
  imageAttachments: boolean;
  cfcEnforcement: boolean;
  structuredErrors: boolean;
}

export const DEFAULT_HARNESS_CHAT_CAPABILITIES: HarnessChatCapabilities = {
  partialTextStream: false,
  toolTelemetry: true,
  fileMutationEvents: true,
  browserProfile: false,
  browserAccessLease: false,
  delegation: true,
  readonlyMode: true,
  imageAttachments: true,
  cfcEnforcement: true,
  structuredErrors: true,
};

export const resolveHarnessChatCapabilities = (
  input: Partial<HarnessChatCapabilities> = {},
): HarnessChatCapabilities => ({
  ...DEFAULT_HARNESS_CHAT_CAPABILITIES,
  ...input,
});

export interface HarnessChatWorkspace {
  hostPath: string;
  cwd?: string;
  sandboxPath?: string;
}

export interface HarnessChatBrowserAccessLease {
  type: "cf-harness.chat.browser-access-lease";
  leaseId: string;
  cdpUrl: string;
  owner?: string;
  expiresAt?: string;
}

export interface HarnessChatPolicy {
  type: "cf-harness.chat-policy";
  toolMode: HarnessChatToolPolicyMode;
  allowedToolIds: readonly BuiltinToolId[];
  allowedSubagentProfiles: readonly HarnessSubagentProfile[];
  cfcEnforcementMode?: CfcEnforcementMode;
  promptSlot?: PromptSlotBinding;
}

export const DEFAULT_HARNESS_CHAT_POLICY: HarnessChatPolicy = {
  type: "cf-harness.chat-policy",
  toolMode: "workspace-write",
  allowedToolIds: DEFAULT_PARENT_TOOL_IDS,
  allowedSubagentProfiles: [DEFAULT_SUBAGENT_PROFILE],
};

export const READONLY_HARNESS_CHAT_POLICY: HarnessChatPolicy = {
  type: "cf-harness.chat-policy",
  toolMode: "read-only",
  allowedToolIds: READONLY_INTERACTIVE_CHAT_TOOL_IDS,
  allowedSubagentProfiles: [],
};

export interface HarnessChatTurnInput {
  text: string;
  imageAttachments?: readonly HarnessImageAttachment[];
}

export interface HarnessChatStartSessionParams {
  sessionId?: string;
  workspace: HarnessChatWorkspace;
  model?: string;
  artifactRoot?: string;
  policy?: HarnessChatPolicy;
  capabilities?: Partial<HarnessChatCapabilities>;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export interface HarnessChatStartTurnParams {
  sessionId: string;
  turnId?: string;
  input: HarnessChatTurnInput;
  policy?: HarnessChatPolicy;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export interface HarnessChatCancelTurnParams {
  sessionId: string;
  turnId?: string;
  reason?: string;
}

export interface HarnessChatCloseSessionParams {
  sessionId: string;
  reason?: string;
}

export interface HarnessChatStatusParams {
  sessionId?: string;
}

export type HarnessChatRequestParamsByMethod = {
  start_session: HarnessChatStartSessionParams;
  start_turn: HarnessChatStartTurnParams;
  cancel_turn: HarnessChatCancelTurnParams;
  close_session: HarnessChatCloseSessionParams;
  status: HarnessChatStatusParams;
};

export type HarnessChatRequestEnvelope<
  Method extends HarnessChatRequestMethod = HarnessChatRequestMethod,
> = {
  [K in Method]: {
    type: typeof HARNESS_CHAT_REQUEST_TYPE;
    protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
    requestId: string;
    method: K;
    params: HarnessChatRequestParamsByMethod[K];
  };
}[Method];

export interface HarnessChatError {
  code:
    | "invalid_request"
    | "session_not_found"
    | "turn_not_found"
    | "turn_already_running"
    | "turn_canceled"
    | "session_closed"
    | "browser_access_required"
    | "policy_denied"
    | "internal_error";
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface HarnessChatOkResponse<Result = unknown> {
  type: typeof HARNESS_CHAT_RESPONSE_TYPE;
  protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: Result;
}

export interface HarnessChatErrorResponse {
  type: typeof HARNESS_CHAT_RESPONSE_TYPE;
  protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: HarnessChatError;
}

export type HarnessChatResponse<Result = unknown> =
  | HarnessChatOkResponse<Result>
  | HarnessChatErrorResponse;

export interface HarnessChatTurnStatus {
  turnId: string;
  status: HarnessChatTurnLifecycle;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  cancelReason?: string;
}

export interface HarnessChatSessionStatus {
  sessionId: string;
  status: HarnessChatSessionLifecycle;
  reusable: boolean;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  activeTurnId?: string;
  activeTurn?: HarnessChatTurnStatus;
  workspace?: HarnessChatWorkspace;
  model?: string;
  harnessRunId?: string;
  artifactRoot?: string;
  capabilities: HarnessChatCapabilities;
  policy: HarnessChatPolicy;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export interface HarnessChatStatusResult {
  sessions: readonly HarnessChatSessionStatus[];
}

export interface HarnessChatToolCallSummary {
  toolCallId: string;
  toolId: BuiltinToolId | string;
  title?: string;
  inputSummary?: Record<string, unknown>;
}

export interface HarnessChatFileChange {
  kind: "create" | "update" | "delete" | "move";
  path: string;
  oldPath?: string;
  oldContent?: string;
  newContent?: string;
  summary?: string;
}

export interface HarnessChatSubagentSummary {
  parentToolCallId: string;
  childRunId?: string;
  profile: HarnessSubagentProfile;
  summary?: string;
}

export interface HarnessChatGatewayUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export type HarnessChatStructuredEvent =
  | {
    kind: "session_started";
    session: HarnessChatSessionStatus;
  }
  | {
    kind: "turn_started";
    turn: HarnessChatTurnStatus;
  }
  | {
    kind: "assistant_delta";
    text: string;
  }
  | {
    kind: "assistant_completed";
    text: string;
  }
  | {
    kind: "tool_started";
    tool: HarnessChatToolCallSummary;
  }
  | {
    kind: "tool_progress";
    toolCallId: string;
    message: string;
    data?: Record<string, unknown>;
  }
  | {
    kind: "tool_completed";
    tool: HarnessChatToolCallSummary;
    status: "completed" | "failed" | "denied";
    resultSummary?: string;
    error?: HarnessChatError;
  }
  | {
    kind: "file_changed";
    change: HarnessChatFileChange;
  }
  | {
    kind: "subagent_started";
    subagent: HarnessChatSubagentSummary;
  }
  | {
    kind: "subagent_completed";
    subagent: HarnessChatSubagentSummary;
    status: "completed" | "failed";
  }
  | {
    kind: "browser_access_required";
    reason: string;
  }
  | {
    kind: "turn_canceled";
    turnId: string;
    reason?: string;
  }
  | {
    kind: "turn_completed";
    turnId: string;
    finalText?: string;
    usage?: HarnessChatGatewayUsage;
  }
  | {
    kind: "status_changed";
    session: HarnessChatSessionStatus;
  }
  | {
    kind: "session_closed";
    reason?: string;
  }
  | {
    kind: "error";
    error: HarnessChatError;
    fatal?: boolean;
  };

export interface HarnessChatEventEnvelope<
  Event extends HarnessChatStructuredEvent = HarnessChatStructuredEvent,
> {
  type: typeof HARNESS_CHAT_EVENT_TYPE;
  protocolVersion: typeof HARNESS_CHAT_PROTOCOL_VERSION;
  sessionId: string;
  turnId?: string;
  sequence: number;
  emittedAt: string;
  event: Event;
}

export interface CreateHarnessChatSessionStatusOptions {
  sessionId: string;
  createdAt?: string;
  workspace?: HarnessChatWorkspace;
  model?: string;
  harnessRunId?: string;
  artifactRoot?: string;
  capabilities?: Partial<HarnessChatCapabilities>;
  policy?: HarnessChatPolicy;
  browserAccess?: HarnessChatBrowserAccessLease;
  metadata?: Record<string, unknown>;
}

export const createHarnessChatSessionStatus = (
  options: CreateHarnessChatSessionStatusOptions,
): HarnessChatSessionStatus => {
  const createdAt = options.createdAt ?? new Date().toISOString();
  return {
    sessionId: options.sessionId,
    status: "idle",
    reusable: true,
    turnCount: 0,
    createdAt,
    updatedAt: createdAt,
    ...(options.workspace !== undefined
      ? { workspace: options.workspace }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.harnessRunId !== undefined
      ? { harnessRunId: options.harnessRunId }
      : {}),
    ...(options.artifactRoot !== undefined
      ? { artifactRoot: options.artifactRoot }
      : {}),
    capabilities: resolveHarnessChatCapabilities(options.capabilities),
    policy: options.policy ?? DEFAULT_HARNESS_CHAT_POLICY,
    ...(options.browserAccess !== undefined
      ? { browserAccess: options.browserAccess }
      : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  };
};

export const createHarnessChatEventEnvelope = <
  Event extends HarnessChatStructuredEvent,
>(
  options:
    & Omit<
      HarnessChatEventEnvelope<Event>,
      "type" | "protocolVersion" | "emittedAt"
    >
    & {
      emittedAt?: string;
    },
): HarnessChatEventEnvelope<Event> => ({
  type: HARNESS_CHAT_EVENT_TYPE,
  protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
  emittedAt: options.emittedAt ?? new Date().toISOString(),
  sessionId: options.sessionId,
  ...(options.turnId !== undefined ? { turnId: options.turnId } : {}),
  sequence: options.sequence,
  event: options.event,
});

export const createHarnessChatOkResponse = <Result>(
  requestId: string,
  result: Result,
): HarnessChatOkResponse<Result> => ({
  type: HARNESS_CHAT_RESPONSE_TYPE,
  protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
  requestId,
  ok: true,
  result,
});

export const createHarnessChatErrorResponse = (
  requestId: string,
  error: HarnessChatError,
): HarnessChatErrorResponse => ({
  type: HARNESS_CHAT_RESPONSE_TYPE,
  protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
  requestId,
  ok: false,
  error,
});

export const reduceHarnessChatSessionStatus = (
  status: HarnessChatSessionStatus,
  envelope: HarnessChatEventEnvelope,
): HarnessChatSessionStatus => {
  const updatedAt = envelope.emittedAt;
  switch (envelope.event.kind) {
    case "session_started":
      return envelope.event.session;
    case "turn_started":
      return {
        ...status,
        status: "turn_running",
        reusable: true,
        activeTurnId: envelope.event.turn.turnId,
        activeTurn: envelope.event.turn,
        turnCount: status.turnCount + 1,
        updatedAt,
      };
    case "turn_canceled": {
      const { activeTurn: _activeTurn, activeTurnId: _activeTurnId, ...rest } =
        status;
      return {
        ...rest,
        status: "idle",
        reusable: true,
        updatedAt,
      };
    }
    case "turn_completed": {
      const { activeTurn: _activeTurn, activeTurnId: _activeTurnId, ...rest } =
        status;
      return {
        ...rest,
        status: "idle",
        reusable: true,
        updatedAt,
      };
    }
    case "status_changed":
      return envelope.event.session;
    case "session_closed": {
      const { activeTurn: _activeTurn, activeTurnId: _activeTurnId, ...rest } =
        status;
      return {
        ...rest,
        status: "closed",
        reusable: false,
        closedAt: updatedAt,
        updatedAt,
      };
    }
    case "error":
      if (!envelope.event.fatal) {
        return {
          ...status,
          updatedAt,
        };
      }
      return {
        ...status,
        status: "failed",
        reusable: false,
        updatedAt,
      };
    default:
      return {
        ...status,
        updatedAt,
      };
  }
};

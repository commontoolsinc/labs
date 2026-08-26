import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type RunHarnessTranscriptOptions,
} from "./prompt-loop.ts";
import {
  createHarnessChatErrorResponse,
  createHarnessChatEventEnvelope,
  createHarnessChatOkResponse,
  createHarnessChatSessionStatus,
  type HarnessChatBrowserAccessLease,
  type HarnessChatError,
  type HarnessChatErrorResponse,
  type HarnessChatEventEnvelope,
  type HarnessChatListEventsParams,
  type HarnessChatListEventsResult,
  type HarnessChatListTurnsParams,
  type HarnessChatListTurnsResult,
  type HarnessChatPolicy,
  type HarnessChatRequestEnvelope,
  type HarnessChatResponse,
  type HarnessChatSessionStatus,
  type HarnessChatStartSessionParams,
  type HarnessChatStartTurnParams,
  type HarnessChatStatusResult,
  type HarnessChatStructuredEvent,
  type HarnessChatTurnRecord,
  type HarnessChatTurnStatus,
  reduceHarnessChatSessionStatus,
  resolveHarnessChatPolicy,
} from "./contracts/interactive-chat.ts";
import { BROWSER_SUBAGENT_PROFILE } from "./contracts/subagent.ts";
import {
  type HarnessCredentialOwnerRef,
  harnessCredentialOwnersEqual,
  type LoomLocalHostBinding,
} from "./contracts/run-manifest.ts";
import {
  type HarnessAssistantTranscriptMessage,
  type HarnessToolCall,
  type HarnessToolTranscriptMessage,
  type HarnessTranscriptMessage,
  isResumableHarnessTranscript,
} from "./contracts/transcript.ts";
import type { HarnessChatSessionStore } from "./session-store.ts";
import { HarnessControlError } from "./control-errors.ts";

export type HarnessInteractivePromptLoop = Pick<
  CfHarnessPromptLoop,
  "runTranscript"
>;

export type HarnessInteractivePromptLoopFactory = (
  options: CreateHarnessPromptLoopOptions,
) => HarnessInteractivePromptLoop;

export type HarnessInteractiveChatEventListener = (
  event: HarnessChatEventEnvelope,
) => void | Promise<void>;

export interface CreateHarnessInteractiveChatServiceOptions {
  basePromptLoopOptions?: CreateHarnessPromptLoopOptions;
  /**
   * The single authenticated owner bound to this service process. Required
   * for openai-codex; interactive requests cannot select or replace it.
   */
  credentialOwner?: HarnessCredentialOwnerRef;
  createPromptLoop?: HarnessInteractivePromptLoopFactory;
  now?: () => string;
  randomUUID?: () => string;
  onEvent?: HarnessInteractiveChatEventListener;
  sessionStore?: HarnessChatSessionStore;
  maxInMemoryEvents?: number;
}

interface HarnessInteractiveChatSessionRecord {
  status: HarnessChatSessionStatus;
  /**
   * The last durable resumable transcript: the model history a following turn
   * is built from. Normal turns advance it only when they complete; legacy
   * recovery may also atomically adopt a normalized transcript. Every snapshot
   * persisted alongside an event is one a provider accepts.
   */
  transcript: readonly HarnessTranscriptMessage[];
  /**
   * Why a restored session cannot be resumed. Set when the recorded history
   * could not be repaired into valid model history; a turn started on such a
   * session is refused rather than sent to a provider.
   */
  recoveryError?: HarnessChatError;
  startingTurnId?: string;
  startingTurn?: HarnessChatTurnStatus;
  activeTurnToken?: object;
  activeTask?: Promise<void>;
  activeAbortController?: AbortController;
  canceledTurnIds: Set<string>;
  turns: Map<string, HarnessChatTurnRecord>;
}

interface HarnessInteractiveChatEmitOptions {
  turnRecord?: HarnessChatTurnRecord;
  createTurn?: boolean;
  /**
   * A transcript to persist with this event and adopt as the session's durable
   * checkpoint. It replaces `record.transcript` only once the durable write has
   * committed, so an event that fails to persist leaves the previous checkpoint
   * in place for the failure path to fall back on.
   */
  transcript?: readonly HarnessTranscriptMessage[];
}

const defaultPromptLoopFactory: HarnessInteractivePromptLoopFactory = (
  options,
) => new CfHarnessPromptLoop(options);

const defaultRandomUUID = (): string => crypto.randomUUID();

class DurableTurnExistsError extends Error {
  readonly sessionId: string;
  readonly turnId: string;

  constructor(sessionId: string, turnId: string) {
    super(`chat turn already exists for session ${sessionId}: ${turnId}`);
    this.name = "DurableTurnExistsError";
    this.sessionId = sessionId;
    this.turnId = turnId;
  }
}

/**
 * The one chat error that waiting alone clears: the turn in flight ends on its
 * own, and the identical request then succeeds. That is what `retryable`
 * claims, in the sense HTTP's `Retry-After` gives it — not that a caller could
 * do something about the failure, which is true of most of the errors here.
 */
const activeTurnError = (
  requestId: string,
  session: HarnessChatSessionStatus,
  activeTurnId = session.activeTurnId,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "turn_already_running",
    message: activeTurnId === undefined
      ? `session ${session.sessionId} already has an active turn task`
      : `session ${session.sessionId} already has active turn ${activeTurnId}`,
    retryable: true,
  });

const sessionExistsError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "session_exists",
    message: `chat session already exists: ${sessionId}`,
  });

const turnExistsError = (
  requestId: string,
  sessionId: string,
  turnId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "turn_exists",
    message: `chat turn already exists for session ${sessionId}: ${turnId}`,
  });

const sessionNotFoundError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "session_not_found",
    message: `chat session not found: ${sessionId}`,
  });

const sessionClosedError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "session_closed",
    message: `chat session is closed: ${sessionId}`,
  });

const providerMismatchError = (
  requestId: string,
  message: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "provider-mismatch",
    message,
  });

const isLoomLocalHostBinding = (
  value: unknown,
): value is LoomLocalHostBinding => {
  if (!isObjectNotArray(value) || value.source !== "loom") {
    return false;
  }
  if (
    value.modelProvider !== "openai-compatible-gateway" &&
    value.modelProvider !== "openai-codex"
  ) {
    return false;
  }
  if (
    value.modelAuthSource !== "api-key" &&
    value.modelAuthSource !== "none" &&
    value.modelAuthSource !== "cf-harness-local-store"
  ) {
    return false;
  }
  const owner = value.credentialOwner;
  return isObjectNotArray(owner) &&
    owner.type === "cf-harness.credential-owner-ref" && owner.version === 1 &&
    typeof owner.ownerKey === "string" && owner.ownerKey.length > 0 &&
    (owner.tenantKey === undefined || typeof owner.tenantKey === "string") &&
    typeof value.harnessHomeIdentity === "string" &&
    value.harnessHomeIdentity.length > 0;
};

const loomLocalHostBindingFromPromptLoopOptions = (
  options: CreateHarnessPromptLoopOptions,
): LoomLocalHostBinding | undefined => {
  const manifest = options.runManifest;
  if (!isLoomLocalHostBinding(manifest)) {
    return undefined;
  }
  const binding: LoomLocalHostBinding = {
    source: "loom",
    modelProvider: manifest.modelProvider,
    modelAuthSource: manifest.modelAuthSource,
    credentialOwner: structuredClone(manifest.credentialOwner),
    harnessHomeIdentity: manifest.harnessHomeIdentity,
  };
  if (
    options.modelProvider !== binding.modelProvider
  ) {
    throw new Error(
      "interactive service provider does not match its Loom-local run manifest",
    );
  }
  if (
    options.modelAuthSource !== undefined &&
    options.modelAuthSource !== binding.modelAuthSource
  ) {
    throw new Error(
      "interactive service auth source does not match its Loom-local run manifest",
    );
  }
  if (
    options.credentialOwner !== undefined &&
    !harnessCredentialOwnersEqual(
      options.credentialOwner,
      binding.credentialOwner,
    )
  ) {
    throw new Error(
      "interactive service credential owner does not match its Loom-local run manifest",
    );
  }
  if (
    options.harnessHomeIdentity !== undefined &&
    options.harnessHomeIdentity !== binding.harnessHomeIdentity
  ) {
    throw new Error(
      "interactive service harness home does not match its Loom-local run manifest",
    );
  }
  return binding;
};

const loomLocalHostBindingsEqual = (
  expected: LoomLocalHostBinding,
  actual: unknown,
): boolean =>
  isLoomLocalHostBinding(actual) &&
  expected.source === actual.source &&
  expected.modelProvider === actual.modelProvider &&
  expected.modelAuthSource === actual.modelAuthSource &&
  harnessCredentialOwnersEqual(
    expected.credentialOwner,
    actual.credentialOwner,
  ) && expected.harnessHomeIdentity === actual.harnessHomeIdentity;

/**
 * A lease reaches a turn on the request that starts it, or on the one that
 * started the session; no request adds one to a session already running. So
 * resending this turn unchanged fails the same way however long the caller
 * waits, and it carries no `retryable` — the next attempt has to carry the
 * lease, which makes it a different request.
 */
const browserAccessRequiredError = (
  requestId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "browser_access_required",
    message: "Browser Access lease is required for browser profile turns.",
  });

const turnNotFoundError = (
  requestId: string,
  sessionId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "turn_not_found",
    message: `active turn not found for session ${sessionId}`,
  });

const createTurnAbortError = (turnId: string, reason: string): DOMException =>
  new DOMException(
    `cf-harness chat turn ${turnId} canceled: ${reason}`,
    "AbortError",
  );

const interruptedTurnError = (
  turnId: string,
  priorStatus: HarnessChatTurnStatus["status"],
): HarnessChatError => ({
  code: "internal_error",
  message:
    `cf-harness chat turn ${turnId} was interrupted before it reached a terminal state`,
  details: {
    terminalReason: "process_interrupted",
    priorStatus,
  },
});

/** A transcript defect whose missing history cannot be inferred honestly. */
type HarnessTranscriptMalformation =
  | "duplicate_tool_call_id"
  | "tool_result_without_pending_call";

/** Identifies where durable transcript normalization found malformed history. */
class MalformedHarnessChatTranscriptError extends Error {
  /** Kind of malformed history encountered. */
  readonly malformation: HarnessTranscriptMalformation;
  /** Zero-based index of the message where validation failed. */
  readonly transcriptIndex: number;

  /** Constructs an instance naming the defect and its transcript position. */
  constructor(
    malformation: HarnessTranscriptMalformation,
    transcriptIndex: number,
  ) {
    super(
      `durable chat transcript is malformed at message ${transcriptIndex}: ${malformation}`,
    );
    this.name = "MalformedHarnessChatTranscriptError";
    this.malformation = malformation;
    this.transcriptIndex = transcriptIndex;
  }
}

/** Returns the chat error for malformed durable history. */
const malformedTranscriptChatError = (
  error: MalformedHarnessChatTranscriptError,
): HarnessChatError => ({
  code: "internal_error",
  message:
    "The durable chat transcript is malformed and cannot be safely repaired.",
  details: {
    reason: "malformed_transcript",
    malformation: error.malformation,
    transcriptIndex: error.transcriptIndex,
  },
});

/** Returns a local protocol response for malformed durable history. */
const malformedTranscriptError = (
  requestId: string,
  error: MalformedHarnessChatTranscriptError,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(
    requestId,
    malformedTranscriptChatError(error),
  );

/** Returns an explicit tool result whose execution outcome remains unknown. */
const unknownToolOutcome = (
  toolCall: HarnessToolCall,
): HarnessToolTranscriptMessage => ({
  role: "tool",
  toolCallId: toolCall.id,
  toolName: toolCall.function.name,
  content: JSON.stringify({
    type: "cf-harness.tool-outcome-unknown",
    outcome: "unknown",
    reason: "process_interrupted",
    message:
      "The run was interrupted after this tool call was recorded and before a result was recorded. Whether the tool ran or produced side effects is unknown. Inspect current state before deciding whether to retry.",
  }),
});

/** Provider-safe transcript and tool results synthesized to make it safe. */
interface NormalizedHarnessChatTranscript {
  /** Transcript with every repairable tool call paired to one result. */
  transcript: HarnessTranscriptMessage[];
  /** Tool call IDs paired to synthesized unknown-outcome results. */
  synthesizedToolCallIds: readonly string[];
}

/**
 * Makes persisted tool exchanges safe for the next provider request without
 * deleting model-visible history. Missing results become explicit
 * unknown-outcome results at the declaring batch boundary, retaining both the
 * original call (including any compaction continuation) and every later
 * message. Existing results pair by call id across the whole transcript, not
 * by adjacency; only results still missing after that scan are synthesized.
 *
 * A tool result without a pending call cannot be repaired honestly: inventing
 * a call would claim an invocation that may never have happened, while deleting
 * the result would erase the only remaining evidence. A reused call id is
 * similarly ambiguous across batches. Callers therefore fail closed for that
 * session before provider traffic rather than guessing.
 */
const normalizeIncompleteToolExchanges = (
  transcript: readonly HarnessTranscriptMessage[],
): NormalizedHarnessChatTranscript => {
  const normalized: HarnessTranscriptMessage[] = [];
  const synthesizedToolCallIds: string[] = [];
  const seenToolCallIds = new Set<string>();
  const pendingToolCalls = new Map<
    string,
    { toolCall: HarnessToolCall; transcriptIndex: number }
  >();

  for (const [index, message] of transcript.entries()) {
    if (message.role === "tool") {
      if (!pendingToolCalls.delete(message.toolCallId)) {
        throw new MalformedHarnessChatTranscriptError(
          "tool_result_without_pending_call",
          index,
        );
      }
      continue;
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }
    const batchToolCallIds = new Set<string>();
    for (const toolCall of message.toolCalls) {
      if (
        seenToolCallIds.has(toolCall.id) ||
        batchToolCallIds.has(toolCall.id)
      ) {
        throw new MalformedHarnessChatTranscriptError(
          "duplicate_tool_call_id",
          index,
        );
      }
      batchToolCallIds.add(toolCall.id);
      seenToolCallIds.add(toolCall.id);
      pendingToolCalls.set(toolCall.id, { toolCall, transcriptIndex: index });
    }
  }

  const insertions = new Map<number, HarnessToolCall[]>();
  for (const { toolCall, transcriptIndex } of pendingToolCalls.values()) {
    // Keep a batch's real contiguous results in their recorded order, then
    // close only its missing calls before later conversation or compaction can
    // move the provider projection boundary past the declaring call.
    let insertionIndex = transcriptIndex;
    while (transcript[insertionIndex + 1]?.role === "tool") {
      insertionIndex += 1;
    }
    const calls = insertions.get(insertionIndex) ?? [];
    calls.push(toolCall);
    insertions.set(insertionIndex, calls);
  }
  for (const [index, message] of transcript.entries()) {
    normalized.push(message);
    for (const toolCall of insertions.get(index) ?? []) {
      normalized.push(unknownToolOutcome(toolCall));
      synthesizedToolCallIds.push(toolCall.id);
    }
  }
  return { transcript: normalized, synthesizedToolCallIds };
};

const unresumableSessionError = (sessionId: string): HarnessChatError => ({
  code: "incomplete_transcript",
  message:
    `chat session was marked not reusable by an earlier recovery: ${sessionId}`,
});

/** Reports a transcript normalization which could not be made durable. */
const normalizationPersistenceError = (
  sessionId: string,
): HarnessChatError => ({
  code: "incomplete_transcript",
  message: `chat session history could not be normalized: ${sessionId}`,
});

/** A prompt loop reported success with history a provider would reject. */
class HarnessIncompleteTranscriptError extends Error {
  constructor(turnId: string) {
    super(
      `cf-harness chat turn ${turnId} completed with history that does not pair its tool calls with tool results`,
    );
    this.name = "HarnessIncompleteTranscriptError";
  }
}

const chatTurnError = (error: unknown): HarnessChatError => {
  if (error instanceof HarnessIncompleteTranscriptError) {
    return { code: "incomplete_transcript", message: error.message };
  }
  if (
    error instanceof HarnessControlError &&
    (error.code === "provider-configuration-required" ||
      error.code === "provider-auth-required" ||
      error.code === "provider-mismatch" ||
      error.code === "provider-unavailable")
  ) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
};

const isTerminalTurnStatus = (
  status: HarnessChatTurnStatus["status"],
): boolean =>
  status === "completed" || status === "failed" || status === "canceled";

const clearActiveTurnStatus = (
  status: HarnessChatSessionStatus,
  updatedAt: string,
): HarnessChatSessionStatus => {
  const { activeTurn: _activeTurn, activeTurnId: _activeTurnId, ...rest } =
    status;
  if (status.status === "closed" || status.status === "failed") {
    return {
      ...rest,
      reusable: false,
      updatedAt,
    };
  }
  return {
    ...rest,
    status: "idle",
    reusable: true,
    updatedAt,
  };
};

const parseToolMessageContent = (
  content: string,
): ReadonlyRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    return isObjectNotArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const toolMessageStatus = (
  parsedContent: ReadonlyRecord | undefined,
): "completed" | "failed" | "denied" => {
  if (parsedContent?.type === "cf-harness.observation-denied") {
    return "denied";
  }
  if (parsedContent?.ok === false) {
    return "failed";
  }
  return "completed";
};

const fileChangeFromToolMessage = (
  message: HarnessToolTranscriptMessage,
  parsedContent: ReadonlyRecord | undefined,
): HarnessChatStructuredEvent | undefined => {
  if (
    parsedContent === undefined ||
    toolMessageStatus(parsedContent) !== "completed"
  ) {
    return undefined;
  }
  const path = parsedContent.path;
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  switch (message.toolName) {
    case "write_file": {
      const mode = typeof parsedContent.mode === "string"
        ? parsedContent.mode
        : "replace";
      return {
        kind: "file_changed",
        change: {
          kind: "update",
          path,
          summary: `write_file ${mode}`,
        },
      };
    }
    case "edit_file": {
      const editsApplied = typeof parsedContent.editsApplied === "number"
        ? parsedContent.editsApplied
        : undefined;
      const replacements = typeof parsedContent.replacements === "number"
        ? parsedContent.replacements
        : undefined;
      return {
        kind: "file_changed",
        change: {
          kind: "update",
          path,
          summary: editsApplied !== undefined || replacements !== undefined
            ? `edit_file applied ${editsApplied ?? "?"} edit(s), ${
              replacements ?? "?"
            } replacement(s)`
            : "edit_file updated file",
        },
      };
    }
    default:
      return undefined;
  }
};

export class HarnessInteractiveChatService {
  readonly #basePromptLoopOptions: CreateHarnessPromptLoopOptions;
  readonly #loomLocalHostBinding?: LoomLocalHostBinding;
  readonly #loomLocalHostModel?: string;
  readonly #createPromptLoop: HarnessInteractivePromptLoopFactory;
  readonly #now: () => string;
  readonly #randomUUID: () => string;
  readonly #onEvent?: HarnessInteractiveChatEventListener;
  readonly #sessionStore?: HarnessChatSessionStore;
  readonly #maxInMemoryEvents?: number;
  readonly #sessions = new Map<string, HarnessInteractiveChatSessionRecord>();
  readonly #events: HarnessChatEventEnvelope[] = [];
  #emitQueue: Promise<void> = Promise.resolve();
  #sequence = 0;

  constructor(options: CreateHarnessInteractiveChatServiceOptions = {}) {
    this.#basePromptLoopOptions = options.basePromptLoopOptions ?? {};
    this.#loomLocalHostBinding = loomLocalHostBindingFromPromptLoopOptions(
      this.#basePromptLoopOptions,
    );
    const manifestModel = this.#basePromptLoopOptions.runManifest?.model;
    if (
      this.#loomLocalHostBinding !== undefined &&
      this.#basePromptLoopOptions.model !== undefined &&
      manifestModel !== undefined &&
      this.#basePromptLoopOptions.model !== manifestModel
    ) {
      throw new Error(
        "interactive service model does not match its Loom-local run manifest",
      );
    }
    this.#loomLocalHostModel = this.#loomLocalHostBinding === undefined
      ? undefined
      : this.#basePromptLoopOptions.model ?? manifestModel;
    const codexConfigured =
      this.#basePromptLoopOptions.modelProvider === "openai-codex" ||
      this.#basePromptLoopOptions.modelClient?.providerId === "openai-codex";
    if (codexConfigured && options.credentialOwner === undefined) {
      throw new Error(
        "openai-codex interactive services require one explicit authenticated credential owner",
      );
    }
    if (
      codexConfigured &&
      this.#basePromptLoopOptions.credentialOwnerKey !==
        options.credentialOwner!.ownerKey
    ) {
      throw new Error(
        "interactive service credential owner does not match the owner-bound model client",
      );
    }
    if (
      codexConfigured &&
      this.#basePromptLoopOptions.modelClient?.credentialOwner === undefined
    ) {
      throw new Error(
        "openai-codex interactive services require a model client with an exact credential owner binding",
      );
    }
    if (
      codexConfigured &&
      !harnessCredentialOwnersEqual(
        this.#basePromptLoopOptions.modelClient!.credentialOwner!,
        options.credentialOwner!,
      )
    ) {
      throw new Error(
        "interactive service credential owner does not match the model client's full owner binding",
      );
    }
    this.#createPromptLoop = options.createPromptLoop ??
      defaultPromptLoopFactory;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#randomUUID = options.randomUUID ?? defaultRandomUUID;
    this.#onEvent = options.onEvent;
    this.#sessionStore = options.sessionStore;
    if (
      options.maxInMemoryEvents !== undefined &&
      (!Number.isInteger(options.maxInMemoryEvents) ||
        options.maxInMemoryEvents < 0)
    ) {
      throw new Error("maxInMemoryEvents must be a non-negative integer");
    }
    this.#maxInMemoryEvents = options.maxInMemoryEvents;
  }

  async initializeFromStore(): Promise<void> {
    if (this.#sessionStore === undefined) {
      return;
    }
    this.#sessions.clear();
    const turnsBySession = new Map<string, HarnessChatTurnRecord[]>();
    for (const turn of await this.#sessionStore.listTurns()) {
      const turns = turnsBySession.get(turn.sessionId) ?? [];
      turns.push(turn);
      turnsBySession.set(turn.sessionId, turns);
    }
    for (const snapshot of await this.#sessionStore.listSessions()) {
      this.#sessions.set(snapshot.session.sessionId, {
        status: snapshot.session,
        transcript: [...snapshot.transcript],
        canceledTurnIds: new Set(),
        turns: new Map(
          (turnsBySession.get(snapshot.session.sessionId) ?? []).map((
            turn,
          ) => [turn.turn.turnId, turn]),
        ),
      });
    }
    this.#events.splice(
      0,
      this.#events.length,
      ...await this.#sessionStore.listEvents(),
    );
    this.#pruneInMemoryEvents();
    this.#sequence = Math.max(
      await this.#sessionStore.latestSequence(),
      ...this.#events.map((event) => event.sequence),
    );
    await this.#terminalizeInterruptedTurnsFromStore();
  }

  events(
    sessionId?: string,
    options: Omit<HarnessChatListEventsParams, "sessionId"> = {},
  ): readonly HarnessChatEventEnvelope[] {
    const afterSequence = options.afterSequence ?? 0;
    const filtered = this.#events.filter((event) =>
      (sessionId === undefined || event.sessionId === sessionId) &&
      event.sequence > afterSequence
    );
    return options.limit === undefined
      ? [...filtered]
      : filtered.slice(0, options.limit);
  }

  listEvents(
    params: HarnessChatListEventsParams = {},
  ): HarnessChatListEventsResult {
    return {
      events: this.events(params.sessionId, {
        afterSequence: params.afterSequence,
        limit: params.limit,
      }),
      latestSequence: this.#sequence,
    };
  }

  async listEventsForReplay(
    params: HarnessChatListEventsParams = {},
  ): Promise<HarnessChatListEventsResult> {
    if (this.#sessionStore === undefined) {
      return this.listEvents(params);
    }
    const [events, latestSequence] = await Promise.all([
      this.#sessionStore.listEvents(params),
      this.#sessionStore.latestSequence(),
    ]);
    return { events, latestSequence };
  }

  turns(
    sessionId?: string,
    options: Omit<HarnessChatListTurnsParams, "sessionId"> = {},
  ): readonly HarnessChatTurnRecord[] {
    const turns = [...this.#sessions.values()].flatMap((
      record,
    ) => [...record.turns.values()]).filter((turn) =>
      (sessionId === undefined || turn.sessionId === sessionId) &&
      (options.status === undefined || turn.turn.status === options.status)
    );
    return turns.map((turn) => ({
      ...turn,
      turn: { ...turn.turn },
    }));
  }

  listTurns(
    params: HarnessChatListTurnsParams = {},
  ): HarnessChatListTurnsResult {
    return {
      turns: this.turns(params.sessionId, { status: params.status }),
    };
  }

  async listTurnsForReplay(
    params: HarnessChatListTurnsParams = {},
  ): Promise<HarnessChatListTurnsResult> {
    if (this.#sessionStore === undefined) {
      return this.listTurns(params);
    }
    return {
      turns: await this.#sessionStore.listTurns(params),
    };
  }

  status(sessionId?: string): HarnessChatStatusResult {
    return {
      sessions: [...this.#sessions.values()]
        .map((record) => record.status)
        .filter((status) =>
          sessionId === undefined || status.sessionId === sessionId
        ),
    };
  }

  async waitForTurn(sessionId: string, turnId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record?.activeTask === undefined) {
      return;
    }
    await record.activeTask;
    const latest = this.#sessions.get(sessionId);
    if (
      latest?.status.activeTurnId === turnId &&
      latest.activeTask !== undefined
    ) {
      await latest.activeTask;
    }
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const tasks = [...this.#sessions.values()].flatMap((record) =>
        record.activeTask === undefined ? [] : [record.activeTask]
      );
      if (tasks.length === 0) {
        return;
      }
      await Promise.allSettled(tasks);
    }
  }

  async #terminalizeInterruptedTurnsFromStore(): Promise<void> {
    for (const record of [...this.#sessions.values()]) {
      let normalized: NormalizedHarnessChatTranscript | undefined;
      let malformation: MalformedHarnessChatTranscriptError | undefined;
      try {
        normalized = normalizeIncompleteToolExchanges(record.transcript);
      } catch (error) {
        if (error instanceof MalformedHarnessChatTranscriptError) {
          malformation = error;
        } else {
          throw error;
        }
      }
      const normalizedTranscript = normalized !== undefined &&
          normalized.synthesizedToolCallIds.length > 0
        ? normalized.transcript
        : undefined;
      const recoveryEmitOptions = (
        options: HarnessInteractiveChatEmitOptions = {},
      ): HarnessInteractiveChatEmitOptions =>
        normalizedTranscript === undefined
          ? options
          : { ...options, transcript: normalizedTranscript };

      const activeTurnId = record.status.activeTurnId;
      const activeTurn = activeTurnId === undefined
        ? undefined
        : record.turns.get(activeTurnId);
      if (activeTurnId !== undefined && activeTurn === undefined) {
        await this.#emit(record.status.sessionId, activeTurnId, {
          kind: "turn_failed",
          turnId: activeTurnId,
          error: interruptedTurnError(
            activeTurnId,
            record.status.activeTurn?.status ?? "running",
          ),
        }, recoveryEmitOptions());
      } else if (
        activeTurn !== undefined &&
        isTerminalTurnStatus(activeTurn.turn.status)
      ) {
        const updatedAt = this.#now();
        const session = clearActiveTurnStatus(record.status, updatedAt);
        const nextTurn = activeTurnId === undefined ? undefined : activeTurn;
        await this.#emit(
          record.status.sessionId,
          undefined,
          {
            kind: "status_changed",
            session,
          },
          recoveryEmitOptions(
            nextTurn === undefined ? {} : { turnRecord: nextTurn },
          ),
        );
      }

      for (const turn of [...record.turns.values()]) {
        if (isTerminalTurnStatus(turn.turn.status)) {
          continue;
        }
        if (turn.turn.status === "canceling") {
          const updatedAt = this.#now();
          const nextTurn = this.#updatedTurnRecord(record, turn.turn.turnId, {
            status: "canceled",
            updatedAt,
            endedAt: updatedAt,
            cancelReason: turn.turn.cancelReason ?? "process_interrupted",
          });
          if (record.status.activeTurnId === turn.turn.turnId) {
            const session = clearActiveTurnStatus(record.status, updatedAt);
            await this.#emit(
              record.status.sessionId,
              undefined,
              {
                kind: "status_changed",
                session,
              },
              recoveryEmitOptions(
                nextTurn === undefined ? {} : { turnRecord: nextTurn },
              ),
            );
          } else if (nextTurn !== undefined) {
            const session = {
              ...record.status,
              updatedAt,
            };
            await this.#emit(record.status.sessionId, undefined, {
              kind: "status_changed",
              session,
            }, recoveryEmitOptions({ turnRecord: nextTurn }));
          }
          continue;
        }
        await this.#emit(record.status.sessionId, turn.turn.turnId, {
          kind: "turn_failed",
          turnId: turn.turn.turnId,
          error: interruptedTurnError(turn.turn.turnId, turn.turn.status),
        }, recoveryEmitOptions());
      }

      if (malformation !== undefined) {
        // Terminalization can make a session reusable, so apply the malformed
        // transcript refusal only after every interrupted turn is settled.
        record.recoveryError = malformedTranscriptChatError(malformation);
        if (record.status.reusable) {
          const updatedAt = this.#now();
          await this.#emit(record.status.sessionId, undefined, {
            kind: "status_changed",
            session: { ...record.status, reusable: false, updatedAt },
          });
        }
        continue;
      }
      if (normalizedTranscript === undefined) {
        // A safe transcript does not explain a durable `reusable=false` marker.
        // Preserve that refusal rather than inferring that the session is safe.
        if (!record.status.reusable) {
          record.recoveryError = unresumableSessionError(
            record.status.sessionId,
          );
        }
        continue;
      }
      if (record.transcript === normalizedTranscript) {
        continue;
      }
      const updatedAt = this.#now();
      // No turn needed terminalization, so persist normalized history on its
      // own status event. Adoption still happens only after the write commits.
      try {
        await this.#emit(record.status.sessionId, undefined, {
          kind: "status_changed",
          session: { ...record.status, updatedAt },
        }, { transcript: normalizedTranscript });
      } catch (error) {
        // #emit adopts the transcript only after the store commit, before it
        // notifies the listener. A listener fault must still propagate, but it
        // cannot turn already-durable provider-safe history into a refusal.
        if (record.transcript !== normalizedTranscript) {
          record.recoveryError = normalizationPersistenceError(
            record.status.sessionId,
          );
        }
        throw error;
      }
    }
  }

  async handleRequest(
    request: HarnessChatRequestEnvelope,
  ): Promise<HarnessChatResponse> {
    const requestId = request.requestId;
    const method = String(request.method);
    switch (request.method) {
      case "start_session":
        return await this.startSession(request.requestId, request.params);
      case "start_turn":
        return await this.startTurn(request.requestId, request.params);
      case "cancel_turn":
        return await this.cancelTurn(
          request.requestId,
          request.params.sessionId,
          request.params.turnId,
          request.params.reason,
        );
      case "close_session":
        return await this.closeSession(
          request.requestId,
          request.params.sessionId,
          request.params.reason,
        );
      case "status":
        return createHarnessChatOkResponse(
          request.requestId,
          this.status(request.params.sessionId),
        );
      case "list_events":
        return createHarnessChatOkResponse(
          request.requestId,
          await this.listEventsForReplay(request.params),
        );
      case "list_turns":
        return createHarnessChatOkResponse(
          request.requestId,
          await this.listTurnsForReplay(request.params),
        );
      default:
        return createHarnessChatErrorResponse(requestId, {
          code: "invalid_request",
          message: `unsupported chat request method: ${method}`,
        });
    }
  }

  async startSession(
    requestId: string,
    params: HarnessChatStartSessionParams,
  ): Promise<HarnessChatResponse<HarnessChatSessionStatus>> {
    const sessionId = params.sessionId ?? this.#randomUUID();
    if (this.#sessions.has(sessionId)) {
      return sessionExistsError(requestId, sessionId);
    }
    if (await this.#sessionStore?.getSession(sessionId) !== undefined) {
      return sessionExistsError(requestId, sessionId);
    }
    if (this.#sessions.has(sessionId)) {
      return sessionExistsError(requestId, sessionId);
    }
    if (
      this.#loomLocalHostModel !== undefined && params.model !== undefined &&
      params.model !== this.#loomLocalHostModel
    ) {
      return providerMismatchError(
        requestId,
        "chat session model does not match the local Loom host binding",
      );
    }
    const model = this.#loomLocalHostModel ?? params.model;
    if (
      this.#loomLocalHostBinding !== undefined &&
      (model === undefined || model.trim() === "")
    ) {
      return providerMismatchError(
        requestId,
        "local Loom chat sessions require a durable model binding",
      );
    }
    const session = createHarnessChatSessionStatus({
      sessionId,
      createdAt: this.#now(),
      workspace: params.workspace,
      context: params.context,
      model,
      loomLocalHostBinding: this.#loomLocalHostBinding,
      artifactRoot: params.artifactRoot,
      capabilities: params.capabilities,
      policy: resolveHarnessChatPolicy(params.policy, params.context),
      browserAccess: params.browserAccess,
      metadata: params.metadata,
    });
    this.#sessions.set(session.sessionId, {
      status: session,
      transcript: [],
      canceledTurnIds: new Set(),
      turns: new Map(),
    });
    try {
      await this.#emit(session.sessionId, undefined, {
        kind: "session_started",
        session,
      });
    } catch (error) {
      this.#sessions.delete(session.sessionId);
      throw error;
    }
    return createHarnessChatOkResponse(requestId, session);
  }

  async startTurn(
    requestId: string,
    params: HarnessChatStartTurnParams,
  ): Promise<HarnessChatResponse<HarnessChatTurnStatus>> {
    const record = this.#sessions.get(params.sessionId);
    if (record === undefined) {
      return sessionNotFoundError(requestId, params.sessionId);
    }
    if (this.#loomLocalHostBinding !== undefined) {
      if (
        !loomLocalHostBindingsEqual(
          this.#loomLocalHostBinding,
          record.status.loomLocalHostBinding,
        )
      ) {
        return providerMismatchError(
          requestId,
          "durable chat session does not match the local Loom host binding",
        );
      }
      if (
        record.status.model === undefined || record.status.model.trim() === ""
      ) {
        return providerMismatchError(
          requestId,
          "durable chat session is missing its model binding",
        );
      }
      if (
        this.#loomLocalHostModel !== undefined &&
        record.status.model !== this.#loomLocalHostModel
      ) {
        return providerMismatchError(
          requestId,
          "durable chat session model does not match the local Loom host binding",
        );
      }
    }
    if (record.status.status === "closed") {
      return sessionClosedError(requestId, params.sessionId);
    }
    if (record.recoveryError !== undefined) {
      return createHarnessChatErrorResponse(requestId, record.recoveryError);
    }
    let normalizedTranscript: NormalizedHarnessChatTranscript;
    try {
      normalizedTranscript = normalizeIncompleteToolExchanges(
        record.transcript,
      );
    } catch (error) {
      if (error instanceof MalformedHarnessChatTranscriptError) {
        return malformedTranscriptError(requestId, error);
      }
      throw error;
    }
    // Under the durable checkpoint invariant this holds by construction. It is
    // kept after legacy normalization so a regression surfaces here, named,
    // instead of as an opaque provider rejection several layers away.
    if (!isResumableHarnessTranscript(normalizedTranscript.transcript)) {
      return createHarnessChatErrorResponse(requestId, {
        code: "incomplete_transcript",
        message: `chat session history is not resumable: ${params.sessionId}`,
      });
    }
    if (record.activeTask !== undefined) {
      return activeTurnError(requestId, record.status);
    }
    if (record.status.activeTurnId !== undefined) {
      return activeTurnError(requestId, record.status);
    }
    if (record.startingTurnId !== undefined) {
      return activeTurnError(requestId, record.status, record.startingTurnId);
    }
    const context = params.context ?? record.status.context;
    const policy = resolveHarnessChatPolicy(
      params.policy ?? record.status.policy,
      context,
    );
    const browserAccess = params.browserAccess ?? record.status.browserAccess;
    if (
      policy.allowedSubagentProfiles.includes(BROWSER_SUBAGENT_PROFILE) &&
      browserAccess === undefined
    ) {
      return browserAccessRequiredError(requestId);
    }

    const turnId = params.turnId ?? this.#randomUUID();
    if (record.turns.has(turnId)) {
      return turnExistsError(requestId, params.sessionId, turnId);
    }

    const startedAt = this.#now();
    const turn: HarnessChatTurnStatus = {
      turnId,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    };
    const turnRecord: HarnessChatTurnRecord = {
      sessionId: params.sessionId,
      turn,
      input: params.input,
      policy,
      ...(context !== undefined ? { context } : {}),
      ...(browserAccess !== undefined ? { browserAccess } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };
    record.startingTurnId = turn.turnId;
    record.startingTurn = turn;
    try {
      if (
        await this.#sessionStore?.getTurn(params.sessionId, turnId) !==
          undefined
      ) {
        return turnExistsError(requestId, params.sessionId, turnId);
      }
      await this.#emit(params.sessionId, turn.turnId, {
        kind: "turn_started",
        turn,
      }, {
        turnRecord,
        createTurn: true,
        ...(normalizedTranscript.synthesizedToolCallIds.length > 0
          ? { transcript: normalizedTranscript.transcript }
          : {}),
      });
    } catch (error) {
      if (error instanceof DurableTurnExistsError) {
        return turnExistsError(requestId, params.sessionId, turnId);
      }
      throw error;
    } finally {
      if (record.startingTurnId === turn.turnId) {
        record.startingTurnId = undefined;
        record.startingTurn = undefined;
      }
    }

    const updatedRecord = this.#sessions.get(params.sessionId);
    if (updatedRecord === undefined) {
      return sessionNotFoundError(requestId, params.sessionId);
    }
    const abortController = new AbortController();
    const turnTask = this.#runTurn(
      updatedRecord,
      turn.turnId,
      params,
      abortController.signal,
      policy,
      browserAccess,
    );
    const activeTurnToken = {};
    const finalizeTask = () =>
      this.#finalizeTurnTask(params.sessionId, turn.turnId, activeTurnToken);
    const task = turnTask.then(finalizeTask, finalizeTask).catch(() => {});
    updatedRecord.activeTurnToken = activeTurnToken;
    updatedRecord.activeTask = task;
    updatedRecord.activeAbortController = abortController;
    return createHarnessChatOkResponse(requestId, turn);
  }

  async cancelTurn(
    requestId: string,
    sessionId: string,
    turnId?: string,
    reason = "canceled",
  ): Promise<HarnessChatResponse<HarnessChatSessionStatus>> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return sessionNotFoundError(requestId, sessionId);
    }
    if (record.status.activeTurnId === undefined) {
      return turnNotFoundError(requestId, sessionId);
    }
    if (turnId !== undefined && record.status.activeTurnId !== turnId) {
      return turnNotFoundError(requestId, sessionId);
    }
    const activeTurnId = record.status.activeTurnId;
    record.canceledTurnIds.add(activeTurnId);
    record.activeAbortController?.abort(
      createTurnAbortError(activeTurnId, reason),
    );
    await this.#emit(sessionId, activeTurnId, {
      kind: "turn_canceled",
      turnId: activeTurnId,
      reason,
    });
    return createHarnessChatOkResponse(
      requestId,
      this.#sessions.get(sessionId)!.status,
    );
  }

  async #finalizeTurnTask(
    sessionId: string,
    turnId: string,
    activeTurnToken: object,
  ): Promise<void> {
    const latest = this.#sessions.get(sessionId);
    if (latest?.activeTurnToken !== activeTurnToken) {
      return;
    }
    latest.activeTurnToken = undefined;
    latest.activeTask = undefined;
    latest.activeAbortController = undefined;
    latest.canceledTurnIds.delete(turnId);
    if (
      latest.status.status === "canceling" &&
      latest.status.activeTurnId === turnId
    ) {
      const updatedAt = this.#now();
      const nextTurn = this.#updatedTurnRecord(latest, turnId, {
        status: "canceled",
        updatedAt,
        endedAt: updatedAt,
        cancelReason: latest.status.activeTurn?.cancelReason,
      });
      const session = clearActiveTurnStatus(latest.status, updatedAt);
      await this.#emit(sessionId, undefined, {
        kind: "status_changed",
        session,
      }, nextTurn === undefined ? {} : { turnRecord: nextTurn });
    }
  }

  async closeSession(
    requestId: string,
    sessionId: string,
    reason = "closed",
  ): Promise<HarnessChatResponse<HarnessChatSessionStatus>> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return sessionNotFoundError(requestId, sessionId);
    }
    if (record.status.activeTurnId !== undefined) {
      const activeTurnId = record.status.activeTurnId;
      record.canceledTurnIds.add(activeTurnId);
      record.activeAbortController?.abort(
        createTurnAbortError(activeTurnId, reason),
      );
      await this.#emit(sessionId, activeTurnId, {
        kind: "turn_canceled",
        turnId: activeTurnId,
        reason,
      });
    }
    await this.#emit(sessionId, undefined, {
      kind: "session_closed",
      reason,
    });
    return createHarnessChatOkResponse(
      requestId,
      this.#sessions.get(sessionId)!.status,
    );
  }

  async #runTurn(
    record: HarnessInteractiveChatSessionRecord,
    turnId: string,
    params: HarnessChatStartTurnParams,
    signal: AbortSignal,
    policy: HarnessChatPolicy,
    browserAccess: HarnessChatBrowserAccessLease | undefined,
  ): Promise<void> {
    const session = record.status;
    const transcript: HarnessTranscriptMessage[] = [
      ...record.transcript,
      {
        role: "user",
        content: params.input.text,
        ...(params.input.imageAttachments !== undefined &&
            params.input.imageAttachments.length > 0
          ? { imageAttachments: params.input.imageAttachments }
          : {}),
      },
    ];
    // Prompt loops replay their initial transcript through onTranscriptEvent.
    // Those messages are durable history, not activity from this turn: in
    // particular, a recovered unknown-outcome result must not be re-emitted as
    // a newly completed tool call.
    let observedTranscriptLength = transcript.length;

    try {
      const loop = this.#createPromptLoop(
        this.#buildPromptLoopOptions(session, policy, browserAccess),
      );
      const result = await loop.runTranscript({
        transcript,
        model: session.model,
        promptSlotBinding: policy.promptSlot,
        signal,
        onTranscriptEvent: async (event) => {
          if (record.canceledTurnIds.has(turnId)) {
            return;
          }
          // The loop replays the transcript it was seeded with before it
          // appends anything. Emitting those messages again would duplicate
          // their tool and assistant events in an append-only log, so only a
          // strictly longer snapshot is worth reporting.
          if (event.transcript.length <= observedTranscriptLength) {
            return;
          }
          observedTranscriptLength = event.transcript.length;
          // The event carries the turn's live transcript, whose tool calls may
          // not have their results yet. It is reported and deliberately not
          // promoted into `record.transcript`: an interrupted turn must not
          // durably commit history a provider would reject. The full working
          // transcript is on disk in the run's artifacts either way.
          await this.#emitTranscriptEvent(session.sessionId, turnId, event);
        },
      });
      if (record.canceledTurnIds.has(turnId)) {
        return;
      }
      // A loop that reports success still has to hand back history a provider
      // accepts. Checking here keeps an unpaired transcript from being promoted
      // and advertised as reusable, rather than leaving it to be discovered on
      // the next turn.
      if (!isResumableHarnessTranscript(result.transcript)) {
        throw new HarnessIncompleteTranscriptError(turnId);
      }
      // The copy keeps the durable checkpoint independent of the array the loop
      // appended to. Passing it through the emit promotes it inside the same
      // transaction that records `turn_completed`, and only if that commits.
      await this.#emit(session.sessionId, turnId, {
        kind: "turn_completed",
        turnId,
        finalText: result.finalAssistantText,
        ...((result.totalUsage ?? result.usage) !== undefined
          ? { usage: result.totalUsage ?? result.usage }
          : {}),
      }, { transcript: [...result.transcript] });
    } catch (error) {
      if (record.canceledTurnIds.has(turnId)) {
        return;
      }
      // `record.transcript` still holds the transcript from before this turn.
      // Persisting it here is the rollback: the turn's partial history stays in
      // the event log and the run artifacts, and never becomes model history.
      await this.#emit(session.sessionId, turnId, {
        kind: "turn_failed",
        turnId,
        error: chatTurnError(error),
      });
    }
  }

  #buildPromptLoopOptions(
    session: HarnessChatSessionStatus,
    policy: HarnessChatPolicy,
    browserAccess?: HarnessChatBrowserAccessLease,
  ): CreateHarnessPromptLoopOptions {
    return {
      ...this.#basePromptLoopOptions,
      ...(session.workspace?.hostPath !== undefined
        ? { workspaceHostPath: session.workspace.hostPath }
        : {}),
      ...(session.workspace?.cwd !== undefined
        ? { cwd: session.workspace.cwd }
        : {}),
      ...(session.model !== undefined ? { model: session.model } : {}),
      ...(this.#loomLocalHostBinding !== undefined &&
          session.model !== undefined
        ? {
          runManifest: {
            ...this.#basePromptLoopOptions.runManifest!,
            model: session.model,
          },
        }
        : {}),
      ...(session.artifactRoot !== undefined
        ? { artifactRoot: session.artifactRoot }
        : {}),
      cacheAffinityKey: `interactive:${session.sessionId}`,
      allowedToolIds: policy.allowedToolIds,
      allowedSubagentProfiles: policy.allowedSubagentProfiles,
      ...(browserAccess !== undefined ? { browserAccess } : {}),
      ...(policy.cfcEnforcementMode !== undefined
        ? { cfcEnforcementModeOverride: policy.cfcEnforcementMode }
        : {}),
    };
  }

  async #emitTranscriptEvent(
    sessionId: string,
    turnId: string,
    event: Parameters<
      NonNullable<RunHarnessTranscriptOptions["onTranscriptEvent"]>
    >[0],
  ): Promise<void> {
    switch (event.message.role) {
      case "assistant":
        await this.#emitAssistantMessage(sessionId, turnId, event.message);
        break;
      case "tool":
        await this.#emitToolMessage(sessionId, turnId, event.message);
        break;
      case "system":
      case "user":
        break;
    }
  }

  async #emitAssistantMessage(
    sessionId: string,
    turnId: string,
    message: HarnessAssistantTranscriptMessage,
  ): Promise<void> {
    for (const toolCall of message.toolCalls ?? []) {
      await this.#emit(sessionId, turnId, {
        kind: "tool_started",
        tool: {
          toolCallId: toolCall.id,
          toolId: toolCall.function.name,
        },
      });
    }
    if (message.content.length === 0) {
      return;
    }
    await this.#emit(sessionId, turnId, {
      kind: "assistant_delta",
      text: message.content,
    });
    await this.#emit(sessionId, turnId, {
      kind: "assistant_completed",
      text: message.content,
    });
  }

  async #emitToolMessage(
    sessionId: string,
    turnId: string,
    message: HarnessToolTranscriptMessage,
  ): Promise<void> {
    const parsedContent = parseToolMessageContent(message.content);
    const status = toolMessageStatus(parsedContent);
    await this.#emit(sessionId, turnId, {
      kind: "tool_completed",
      status,
      tool: {
        toolCallId: message.toolCallId,
        toolId: message.toolName,
      },
      resultSummary: message.content,
    });
    const fileChange = fileChangeFromToolMessage(message, parsedContent);
    if (fileChange !== undefined) {
      await this.#emit(sessionId, turnId, fileChange);
    }
  }

  #updatedTurnRecord(
    record: HarnessInteractiveChatSessionRecord,
    turnId: string,
    update:
      & Pick<HarnessChatTurnStatus, "status" | "updatedAt">
      & Partial<
        Pick<HarnessChatTurnStatus, "endedAt" | "cancelReason" | "error">
      >,
  ): HarnessChatTurnRecord | undefined {
    const current = record.turns.get(turnId);
    if (current === undefined) {
      return undefined;
    }
    return {
      ...current,
      turn: {
        ...current.turn,
        ...update,
      },
    };
  }

  #turnRecordFromEvent(
    record: HarnessInteractiveChatSessionRecord,
    envelope: HarnessChatEventEnvelope,
  ): HarnessChatTurnRecord | undefined {
    switch (envelope.event.kind) {
      case "turn_started":
        return this.#updatedTurnRecord(record, envelope.event.turn.turnId, {
          status: envelope.event.turn.status,
          updatedAt: envelope.event.turn.updatedAt,
        });
      case "turn_canceled":
        return this.#updatedTurnRecord(record, envelope.event.turnId, {
          status: "canceling",
          updatedAt: envelope.emittedAt,
          cancelReason: envelope.event.reason,
        });
      case "turn_completed":
        return this.#updatedTurnRecord(record, envelope.event.turnId, {
          status: "completed",
          updatedAt: envelope.emittedAt,
          endedAt: envelope.emittedAt,
        });
      case "turn_failed":
        return this.#updatedTurnRecord(record, envelope.event.turnId, {
          status: "failed",
          updatedAt: envelope.emittedAt,
          endedAt: envelope.emittedAt,
          error: envelope.event.error,
        });
      case "session_closed": {
        const activeTurnId = record.status.activeTurnId;
        return activeTurnId === undefined
          ? undefined
          : this.#updatedTurnRecord(record, activeTurnId, {
            status: "canceled",
            updatedAt: envelope.emittedAt,
            endedAt: envelope.emittedAt,
            cancelReason: envelope.event.reason,
          });
      }
      default:
        return undefined;
    }
  }

  async #emit(
    sessionId: string,
    turnId: string | undefined,
    event: HarnessChatStructuredEvent,
    options: HarnessInteractiveChatEmitOptions = {},
  ): Promise<void> {
    const emitTask = this.#emitQueue.then(() =>
      this.#emitImmediately(sessionId, turnId, event, options)
    );
    this.#emitQueue = emitTask.catch(() => undefined);
    return await emitTask;
  }

  async #emitImmediately(
    sessionId: string,
    turnId: string | undefined,
    event: HarnessChatStructuredEvent,
    options: HarnessInteractiveChatEmitOptions,
  ): Promise<void> {
    const sequence = this.#sequence + 1;
    const envelope = createHarnessChatEventEnvelope({
      sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      sequence,
      emittedAt: this.#now(),
      event,
    });
    const record = this.#sessions.get(sessionId);
    const transcript = options.transcript ?? record?.transcript ?? [];
    const nextStatus = record === undefined
      ? undefined
      : reduceHarnessChatSessionStatus(record.status, envelope);
    const nextTurn = options.turnRecord ??
      (record === undefined
        ? undefined
        : this.#turnRecordFromEvent(record, envelope));
    if (record !== undefined && nextStatus !== undefined) {
      if (nextTurn !== undefined) {
        const saved = await this.#sessionStore?.saveSessionTurnAndAppendEvent({
          session: { session: nextStatus, transcript },
          turn: nextTurn,
          event: envelope,
          ...(options.createTurn ? { createTurn: true } : {}),
        });
        if (saved === false) {
          throw new DurableTurnExistsError(sessionId, nextTurn.turn.turnId);
        }
      } else {
        await this.#sessionStore?.saveSessionAndAppendEvent({
          session: nextStatus,
          transcript,
        }, envelope);
      }
    } else {
      await this.#sessionStore?.appendEvent(envelope);
    }
    this.#sequence = sequence;
    this.#events.push(envelope);
    this.#pruneInMemoryEvents();
    if (record !== undefined && options.transcript !== undefined) {
      record.transcript = options.transcript;
    }
    if (record !== undefined && nextStatus !== undefined) {
      record.status = nextStatus;
    }
    if (record !== undefined && nextTurn !== undefined) {
      record.turns.set(nextTurn.turn.turnId, nextTurn);
    }
    await this.#onEvent?.(envelope);
  }

  #pruneInMemoryEvents(): void {
    if (
      this.#maxInMemoryEvents === undefined ||
      this.#events.length <= this.#maxInMemoryEvents
    ) {
      return;
    }
    this.#events.splice(0, this.#events.length - this.#maxInMemoryEvents);
  }
}

export const createHarnessInteractiveChatService = (
  options: CreateHarnessInteractiveChatServiceOptions = {},
): HarnessInteractiveChatService => new HarnessInteractiveChatService(options);

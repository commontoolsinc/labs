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
} from "./contracts/run-manifest.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessToolTranscriptMessage,
  HarnessTranscriptMessage,
} from "./contracts/transcript.ts";
import type { HarnessChatSessionStore } from "./session-store.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  transcript: HarnessTranscriptMessage[];
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

const browserAccessRequiredError = (
  requestId: string,
): HarnessChatErrorResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "browser_access_required",
    message: "Browser Access lease is required for browser profile turns.",
    retryable: true,
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
): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const toolMessageStatus = (
  parsedContent: Record<string, unknown> | undefined,
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
  parsedContent: Record<string, unknown> | undefined,
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
        });
      } else if (
        activeTurn !== undefined &&
        isTerminalTurnStatus(activeTurn.turn.status)
      ) {
        const updatedAt = this.#now();
        const session = clearActiveTurnStatus(record.status, updatedAt);
        const nextTurn = activeTurnId === undefined ? undefined : activeTurn;
        await this.#emit(record.status.sessionId, undefined, {
          kind: "status_changed",
          session,
        }, nextTurn === undefined ? {} : { turnRecord: nextTurn });
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
            await this.#emit(record.status.sessionId, undefined, {
              kind: "status_changed",
              session,
            }, nextTurn === undefined ? {} : { turnRecord: nextTurn });
          } else if (nextTurn !== undefined) {
            const session = {
              ...record.status,
              updatedAt,
            };
            await this.#emit(record.status.sessionId, undefined, {
              kind: "status_changed",
              session,
            }, { turnRecord: nextTurn });
          }
          continue;
        }
        await this.#emit(record.status.sessionId, turn.turn.turnId, {
          kind: "turn_failed",
          turnId: turn.turn.turnId,
          error: interruptedTurnError(turn.turn.turnId, turn.turn.status),
        });
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
    const session = createHarnessChatSessionStatus({
      sessionId,
      createdAt: this.#now(),
      workspace: params.workspace,
      context: params.context,
      model: params.model,
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
    if (record.status.status === "closed") {
      return sessionClosedError(requestId, params.sessionId);
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
      }, { turnRecord, createTurn: true });
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
          if (event.transcript.length <= observedTranscriptLength) {
            return;
          }
          observedTranscriptLength = event.transcript.length;
          record.transcript = [...event.transcript];
          await this.#emitTranscriptEvent(session.sessionId, turnId, event);
        },
      });
      if (record.canceledTurnIds.has(turnId)) {
        return;
      }
      record.transcript = result.transcript;
      await this.#emit(session.sessionId, turnId, {
        kind: "turn_completed",
        turnId,
        finalText: result.finalAssistantText,
      });
    } catch (error) {
      if (record.canceledTurnIds.has(turnId)) {
        return;
      }
      await this.#emit(session.sessionId, turnId, {
        kind: "turn_failed",
        turnId,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
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
      ...(session.artifactRoot !== undefined
        ? { artifactRoot: session.artifactRoot }
        : {}),
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
          session: {
            session: nextStatus,
            transcript: record.transcript,
          },
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
          transcript: record.transcript,
        }, envelope);
      }
    } else {
      await this.#sessionStore?.appendEvent(envelope);
    }
    this.#sequence = sequence;
    this.#events.push(envelope);
    this.#pruneInMemoryEvents();
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

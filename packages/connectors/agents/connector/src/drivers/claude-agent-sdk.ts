import * as defaultSdk from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDriver,
  AgentSourceConfig,
  CommandExecutionOptions,
  CommandExecutionResult,
  NativeSessionSnapshot,
  PromptInput,
  SessionPage,
  SessionSummary,
  SourceDescriptor,
} from "../types.ts";
import { AsyncSerialQueue } from "../serial-queue.ts";
import { normalizeSourceId } from "../session-contract.ts";

interface ClaudeSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
}

interface ClaudeSessionMessage {
  type: string;
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
}

interface ClaudeQuery extends AsyncGenerator<unknown, void> {
  interrupt(): Promise<unknown>;
  setPermissionMode(
    mode:
      | "default"
      | "acceptEdits"
      | "bypassPermissions"
      | "plan"
      | "dontAsk"
      | "auto",
  ): Promise<void>;
  setModel(model?: string): Promise<void>;
  close(): void;
}

interface PendingClaudePrompt {
  cancellation: "cancelled" | "stopped" | null;
}

export interface ClaudeSdkAdapter {
  listSessions(
    options?: { limit?: number; offset?: number },
  ): Promise<ClaudeSessionInfo[]>;
  getSessionInfo(sessionId: string): Promise<ClaudeSessionInfo | undefined>;
  getSessionMessages(
    sessionId: string,
    options?: { includeSystemMessages?: boolean },
  ): Promise<ClaudeSessionMessage[]>;
  renameSession(sessionId: string, title: string): Promise<void>;
  query(params: {
    prompt: string;
    options?: Record<string, unknown>;
  }): ClaudeQuery;
}

const PAGE_SIZE = 100;
const PREVIEW_LIMIT = 500;
const claudeSourceEnvironment = new AsyncSerialQueue();

function isoFromMillis(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function asRaw(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? { ...value as Record<string, unknown> }
    : { value };
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, PREVIEW_LIMIT);
  if (Array.isArray(value)) {
    const joined = value.map(textFrom).filter((item): item is string =>
      Boolean(item)
    ).join("\n");
    return joined ? joined.slice(0, PREVIEW_LIMIT) : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text.slice(0, PREVIEW_LIMIT);
  }
  if ("content" in record) return textFrom(record.content);
  return null;
}

function summaryFrom(
  info: ClaudeSessionInfo,
  connectorQueryActive: boolean,
): SessionSummary {
  return {
    nativeSessionId: info.sessionId,
    title: info.customTitle || info.summary || info.firstPrompt || null,
    cwd: info.cwd || null,
    createdAt: isoFromMillis(info.createdAt),
    updatedAt: isoFromMillis(info.lastModified),
    // TODO(@ianh): Populate archive and provider-wide activity state when
    // Claude's session inventory provides it. Query tracking identifies only
    // prompts started by this process.
    archived: null,
    active: connectorQueryActive ? true : null,
    raw: asRaw(info),
  };
}

function unsupported(message: string): CommandExecutionResult {
  return {
    status: "unsupported",
    error: { code: "unsupported", message, retryable: false },
  };
}

function pendingPromptCancellation(
  cancellation: NonNullable<PendingClaudePrompt["cancellation"]>,
): CommandExecutionResult {
  return {
    status: "failed",
    error: {
      code: cancellation === "cancelled"
        ? "cancelled"
        : "claude-driver-stopped",
      message: cancellation === "cancelled"
        ? "Claude prompt was cancelled before starting"
        : "Claude driver stopped before the prompt started",
      retryable: cancellation === "stopped",
    },
  };
}

export function claudeTerminalResult(
  value: unknown,
): CommandExecutionResult {
  const result = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (result.type !== "result") {
    return {
      status: "unknown",
      error: {
        code: "claude-query-outcome-unknown",
        message: "Claude query ended without a terminal result",
        retryable: false,
      },
    };
  }
  if (result.subtype === "success" && result.is_error !== true) {
    return { status: "succeeded", result: { completed: true } };
  }
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((item): item is string => typeof item === "string")
    : [];
  const subtype = typeof result.subtype === "string"
    ? result.subtype
    : "error_during_execution";
  return {
    status: "failed",
    error: {
      code: `claude-${subtype}`,
      message: errors.join("; ") ||
        (typeof result.terminal_reason === "string"
          ? result.terminal_reason
          : `Claude query ended with ${subtype}`),
      retryable: false,
    },
  };
}

export class ClaudeAgentSdkDriver implements AgentDriver {
  readonly source: SourceDescriptor;
  readonly #config: AgentSourceConfig;
  readonly #sdk: ClaudeSdkAdapter;
  readonly #queryBaseEnvironment: Record<string, string>;
  readonly #activeQueries = new Map<string, ClaudeQuery>();
  readonly #pendingPrompts = new Map<string, PendingClaudePrompt>();
  readonly #sessionCwds = new Map<string, string | null>();
  readonly #sessionModes = new Map<string, string>();
  readonly #sessionModels = new Map<string, string>();
  #stopped = false;

  constructor(
    config: AgentSourceConfig,
    sdk: ClaudeSdkAdapter = defaultSdk as unknown as ClaudeSdkAdapter,
  ) {
    this.#config = config;
    this.#sdk = sdk;
    // Short SDK calls temporarily mutate Deno.env under a global lock. Keep a
    // stable baseline so a concurrent prompt cannot snapshot another source's
    // temporary values into its explicit per-query environment.
    this.#queryBaseEnvironment = Deno.env.toObject();
    this.source = {
      id: normalizeSourceId(config.id),
      driver: config.driver,
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
        modes: [
          "default",
          "acceptEdits",
          "plan",
          "dontAsk",
          "auto",
          ...(config.allowDangerFullAccess ? ["bypassPermissions"] : []),
        ],
        configOptions: { model: { type: "string" } },
      },
    };
  }

  start(signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      this.#stopped = false;
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  stop(): Promise<void> {
    this.#stopped = true;
    for (const pending of this.#pendingPrompts.values()) {
      pending.cancellation ??= "stopped";
    }
    this.#pendingPrompts.clear();
    for (const query of this.#activeQueries.values()) query.close();
    this.#activeQueries.clear();
    return Promise.resolve();
  }

  async listSessions(cursor?: string): Promise<SessionPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("invalid Claude cursor");
    }
    const activeSessionIds = new Set(this.#activeQueries.keys());
    const sessions = await this.#withSourceEnvironment(() =>
      this.#sdk.listSessions({ limit: PAGE_SIZE, offset })
    );
    for (const info of sessions) this.#rememberSessionCwd(info);
    return {
      sessions: sessions.map((info) =>
        summaryFrom(info, activeSessionIds.has(info.sessionId))
      ),
      nextCursor: sessions.length === PAGE_SIZE
        ? String(offset + PAGE_SIZE)
        : undefined,
    };
  }

  async readSession(nativeSessionId: string): Promise<NativeSessionSnapshot> {
    const connectorQueryActive = this.#activeQueries.has(nativeSessionId);
    const [info, messages] = await this.#withSourceEnvironment(() =>
      Promise.all([
        this.#sdk.getSessionInfo(nativeSessionId),
        this.#sdk.getSessionMessages(nativeSessionId, {
          includeSystemMessages: true,
        }),
      ])
    );
    if (!info) throw new Error(`Claude session not found: ${nativeSessionId}`);
    this.#rememberSessionCwd(info);
    return {
      summary: summaryFrom(info, connectorQueryActive),
      events: messages.map((message) => asRaw(message)),
      normalizedMessages: messages.map((message, rawIndex) => ({
        id: message.uuid,
        role: message.type === "user" || message.type === "assistant" ||
            message.type === "system"
          ? message.type
          : "unknown",
        kind: message.type,
        createdAt: null,
        textPreview: textFrom(message.message),
        rawIndex,
      })),
      complete: true,
      revision: String(info.lastModified),
    };
  }

  async renameSession(
    nativeSessionId: string,
    title: string,
  ): Promise<CommandExecutionResult> {
    await this.#withSourceEnvironment(() =>
      this.#sdk.renameSession(nativeSessionId, title)
    );
    return { status: "succeeded", result: { title } };
  }

  async prompt(
    nativeSessionId: string,
    input: PromptInput,
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    if (this.#stopped) {
      return {
        status: "failed",
        error: {
          code: "claude-driver-stopped",
          message: "Claude driver is stopped",
          retryable: true,
        },
      };
    }
    if (
      this.#activeQueries.has(nativeSessionId) ||
      this.#pendingPrompts.has(nativeSessionId)
    ) {
      return {
        status: "needs-confirmation",
        error: {
          code: "already-active",
          message: "session already has a pending or active connector query",
          retryable: true,
        },
      };
    }
    const pending: PendingClaudePrompt = { cancellation: null };
    this.#pendingPrompts.set(nativeSessionId, pending);
    try {
      options.onCancellationReady?.();
      let sessionCwd: string | null | undefined;
      try {
        sessionCwd = this.#sessionCwds.has(nativeSessionId)
          ? this.#sessionCwds.get(nativeSessionId)
          : await this.#lookupSessionCwd(nativeSessionId);
      } catch (error) {
        if (pending.cancellation) {
          return pendingPromptCancellation(pending.cancellation);
        }
        return {
          status: "failed",
          error: {
            code: "claude-session-lookup-failed",
            message: String(error),
            retryable: true,
          },
        };
      }
      if (pending.cancellation) {
        return pendingPromptCancellation(pending.cancellation);
      }
      if (sessionCwd === undefined) {
        return {
          status: "failed",
          error: {
            code: "claude-session-not-found",
            message: `Claude session not found: ${nativeSessionId}`,
            retryable: false,
          },
        };
      }
      const promptCwd = sessionCwd || this.#config.cwd;

      // query() accepts an explicit environment. Do not use
      // #withSourceEnvironment here: its module-global queue is only for short
      // SDK methods that lack an env option, and holding it across a full turn
      // would block every Claude source behind one in-flight prompt.
      const query = this.#sdk.query({
        prompt: input.text,
        options: {
          resume: nativeSessionId,
          ...(this.#sessionModes.has(nativeSessionId)
            ? { permissionMode: this.#sessionModes.get(nativeSessionId) }
            : {}),
          ...(this.#sessionModels.has(nativeSessionId)
            ? { model: this.#sessionModels.get(nativeSessionId) }
            : {}),
          ...(this.#sessionModes.get(nativeSessionId) === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(promptCwd ? { cwd: promptCwd } : {}),
          env: {
            ...this.#queryBaseEnvironment,
            ...this.#config.env,
            ...(this.#config.configDir
              ? { CLAUDE_CONFIG_DIR: this.#config.configDir }
              : {}),
          },
        },
      });
      this.#activeQueries.set(nativeSessionId, query);
      if (this.#pendingPrompts.get(nativeSessionId) === pending) {
        this.#pendingPrompts.delete(nativeSessionId);
      }
      let lastMessage: unknown;
      try {
        await options.onSessionActive?.();
        for await (const message of query) lastMessage = message;
        return claudeTerminalResult(lastMessage);
      } catch (error) {
        return {
          status: "failed",
          error: {
            code: "claude-query-failed",
            message: String(error),
            retryable: false,
          },
        };
      } finally {
        if (this.#activeQueries.get(nativeSessionId) === query) {
          this.#activeQueries.delete(nativeSessionId);
        }
        query.close();
      }
    } finally {
      if (this.#pendingPrompts.get(nativeSessionId) === pending) {
        this.#pendingPrompts.delete(nativeSessionId);
      }
    }
  }

  #withSourceEnvironment<T>(operation: () => Promise<T>): Promise<T> {
    return claudeSourceEnvironment.run(async () => {
      const sourceEnv = {
        ...this.#config.env,
        ...(this.#config.configDir
          ? { CLAUDE_CONFIG_DIR: this.#config.configDir }
          : {}),
      };
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(sourceEnv)) {
        previous.set(key, Deno.env.get(key));
        Deno.env.set(key, value);
      }
      try {
        return await operation();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) Deno.env.delete(key);
          else Deno.env.set(key, value);
        }
      }
    });
  }

  async #lookupSessionCwd(
    nativeSessionId: string,
  ): Promise<string | null | undefined> {
    const info = await this.#withSourceEnvironment(() =>
      this.#sdk.getSessionInfo(nativeSessionId)
    );
    if (!info) return undefined;
    this.#rememberSessionCwd(info);
    return this.#sessionCwds.get(nativeSessionId);
  }

  #rememberSessionCwd(info: ClaudeSessionInfo): void {
    this.#sessionCwds.set(info.sessionId, info.cwd || null);
  }

  async cancel(nativeSessionId: string): Promise<CommandExecutionResult> {
    const pending = this.#pendingPrompts.get(nativeSessionId);
    if (pending) {
      pending.cancellation = "cancelled";
      return { status: "succeeded" };
    }
    const query = this.#activeQueries.get(nativeSessionId);
    if (!query) {
      return unsupported(
        "Claude cancel is available only for a connector-owned query",
      );
    }
    await query.interrupt();
    return { status: "succeeded" };
  }

  async setMode(
    nativeSessionId: string,
    mode: string,
  ): Promise<CommandExecutionResult> {
    const modes: string[] = this.source.capabilities.modes ?? [];
    if (!modes.includes(mode)) {
      return unsupported(`unsupported Claude mode: ${mode}`);
    }
    this.#sessionModes.set(nativeSessionId, mode);
    const query = this.#activeQueries.get(nativeSessionId);
    if (query) {
      await query.setPermissionMode(
        mode as Parameters<ClaudeQuery["setPermissionMode"]>[0],
      );
    }
    return {
      status: "succeeded",
      result: { mode, appliesTo: "connector-prompts" },
    };
  }

  async setConfigOption(
    nativeSessionId: string,
    key: string,
    value: unknown,
  ): Promise<CommandExecutionResult> {
    if (key !== "model" || typeof value !== "string") {
      return unsupported(`unsupported Claude config option: ${key}`);
    }
    this.#sessionModels.set(nativeSessionId, value);
    const query = this.#activeQueries.get(nativeSessionId);
    if (query) await query.setModel(value);
    return {
      status: "succeeded",
      result: { key, value, appliesTo: "connector-prompts" },
    };
  }
}

export type DriverKind =
  | "claude-agent-sdk"
  | "codex-app-server"
  | "acp";

export type CodexAppServerTransport = "stdio" | "managed" | "proxy";

export interface AgentSourceConfig {
  id: string;
  driver: DriverKind;
  enabled: boolean;
  command?: string[];
  configDir?: string;
  codexBin?: string;
  codexHome?: string;
  codexTransport?: CodexAppServerTransport;
  codexSocket?: string;
  cwd?: string;
  env?: Record<string, string>;
  allowDangerFullAccess?: boolean;
}

export interface DriverCapabilities {
  inventory: boolean;
  read: boolean;
  prompt: boolean;
  cancel: boolean;
  rename: boolean;
  setMode: boolean;
  setConfigOption: boolean;
  modes?: string[];
  configOptions?: Record<string, unknown>;
}

export interface SourceDescriptor {
  /** Trimmed, lowercase source identity used by commands and Fabric records. */
  id: string;
  driver: DriverKind;
  version?: string;
  capabilities: DriverCapabilities;
}

export interface SessionSummary {
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  gitWorktreeRoot?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean | null;
  active: boolean | null;
  raw: Record<string, unknown>;
}

export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor?: string;
}

export interface NormalizedMessage {
  id: string;
  parentId?: string;
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  kind: string;
  createdAt: string | null;
  textPreview: string | null;
  rawIndex: number;
}

export interface NativeSessionSnapshot {
  summary: SessionSummary;
  events: unknown[];
  normalizedMessages: NormalizedMessage[];
  complete: boolean;
  revision?: string;
}

export interface PromptInput {
  text: string;
}

export interface CommandExecutionOptions {
  force?: boolean;
  onCancellationReady?: () => void;
  onSessionActive?: () => Promise<void>;
}

export interface CommandExecutionResult {
  status:
    | "succeeded"
    | "failed"
    | "unsupported"
    | "needs-confirmation"
    | "unknown";
  providerOperationId?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface AgentDriver {
  readonly source: SourceDescriptor;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  listSessions(cursor?: string): Promise<SessionPage>;
  readSession(nativeSessionId: string): Promise<NativeSessionSnapshot>;
  prompt(
    nativeSessionId: string,
    input: PromptInput,
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult>;
  cancel(nativeSessionId: string): Promise<CommandExecutionResult>;
  renameSession(
    nativeSessionId: string,
    title: string,
  ): Promise<CommandExecutionResult>;
  setMode(
    nativeSessionId: string,
    mode: string,
  ): Promise<CommandExecutionResult>;
  setConfigOption(
    nativeSessionId: string,
    key: string,
    value: unknown,
  ): Promise<CommandExecutionResult>;
}

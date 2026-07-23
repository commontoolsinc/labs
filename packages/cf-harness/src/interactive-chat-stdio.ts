import { resolve, toFileUrl } from "@std/path";
import {
  createHarnessChatErrorResponse,
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
  HARNESS_CHAT_RESPONSE_TYPE,
  type HarnessChatEventEnvelope,
  type HarnessChatRequestEnvelope,
  type HarnessChatRequestMethod,
  type HarnessChatResponse,
} from "./contracts/interactive-chat.ts";
import {
  HARNESS_BROWSER_ACCESS_ACCOUNT_ACCESS,
  HARNESS_BROWSER_ACCESS_LEASE_TYPE,
  HARNESS_BROWSER_ACCESS_PROFILE_MODES,
} from "./contracts/browser-access.ts";
import { normalizePromptSlotBinding } from "./contracts/prompt-slot.ts";
import {
  HARNESS_SUBAGENT_PROFILES,
  type HarnessSubagentProfile,
} from "./contracts/subagent.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import {
  createHarnessInteractiveChatService,
  type HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "./interactive-chat-service.ts";
import type { HarnessChatSessionStore } from "./session-store.ts";
import type { CreateHarnessPromptLoopOptions } from "./prompt-loop.ts";

export type HarnessInteractiveChatOutputEnvelope =
  | HarnessChatEventEnvelope
  | HarnessChatResponse;

export interface RunHarnessInteractiveChatNdjsonTransportOptions {
  lines: AsyncIterable<string> | Iterable<string>;
  writeLine: (line: string) => void | Promise<void>;
  createService?: (
    onEvent: (event: HarnessChatEventEnvelope) => void | Promise<void>,
  ) => HarnessInteractiveChatService | Promise<HarnessInteractiveChatService>;
  closeService?: (
    service: HarnessInteractiveChatService,
  ) => void | Promise<void>;
}

export interface RunHarnessInteractiveChatStdioOptions {
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
  sessionDbPath?: string;
  maxInMemoryEvents?: number;
  /** Trusted host injection point for an owner-bound provider client. */
  basePromptLoopOptions?: CreateHarnessPromptLoopOptions;
  createPromptLoop?: HarnessInteractivePromptLoopFactory;
  createService?: (
    onEvent: (event: HarnessChatEventEnvelope) => void | Promise<void>,
  ) => HarnessInteractiveChatService | Promise<HarnessInteractiveChatService>;
}

export interface HarnessInteractiveChatStdioCliOptions {
  sessionDbPath?: string;
  maxInMemoryEvents?: number;
  help: boolean;
}

const CHAT_SESSION_DB_ENV = "CF_HARNESS_CHAT_SESSION_DB";
const CHAT_MAX_IN_MEMORY_EVENTS_ENV = "CF_HARNESS_CHAT_MAX_IN_MEMORY_EVENTS";

const invalidRequestResponse = (
  message: string,
  requestId = "invalid",
): HarnessChatResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "invalid_request",
    message,
  });

const usageText = `Usage: deno run -A src/interactive-chat-stdio.ts [options]

Options:
  --chat-session-db <path>             Persist chat sessions, turns, and events in SQLite
  --chat-max-in-memory-events <count>  Retain at most count events in memory
  --help                              Print this help text to stderr

Environment:
  ${CHAT_SESSION_DB_ENV}                 Default SQLite chat session DB path
  ${CHAT_MAX_IN_MEMORY_EVENTS_ENV}       Default in-memory event retention cap
`;

const nonEmptyOptionValue = (
  name: string,
  value: string | undefined,
): string => {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} requires a non-empty value`);
  }
  return value;
};

const parseNonNegativeIntegerOption = (
  name: string,
  value: string | undefined,
): number => {
  const rawValue = nonEmptyOptionValue(name, value).trim();
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} requires a non-negative integer value`);
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} requires a safe non-negative integer value`);
  }
  return parsed;
};

export const parseHarnessInteractiveChatStdioCliOptions = (
  args: readonly string[],
  env: Record<string, string | undefined> = Deno.env.toObject(),
): HarnessInteractiveChatStdioCliOptions => {
  let sessionDbPath = env[CHAT_SESSION_DB_ENV];
  let maxInMemoryEvents = env[CHAT_MAX_IN_MEMORY_EVENTS_ENV] === undefined ||
      env[CHAT_MAX_IN_MEMORY_EVENTS_ENV]?.trim() === ""
    ? undefined
    : parseNonNegativeIntegerOption(
      CHAT_MAX_IN_MEMORY_EVENTS_ENV,
      env[CHAT_MAX_IN_MEMORY_EVENTS_ENV],
    );
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--chat-session-db") {
      index += 1;
      sessionDbPath = nonEmptyOptionValue(arg, args[index]);
      continue;
    }
    if (arg.startsWith("--chat-session-db=")) {
      sessionDbPath = nonEmptyOptionValue(
        "--chat-session-db",
        arg.slice("--chat-session-db=".length),
      );
      continue;
    }
    if (arg === "--chat-max-in-memory-events") {
      index += 1;
      maxInMemoryEvents = parseNonNegativeIntegerOption(arg, args[index]);
      continue;
    }
    if (arg.startsWith("--chat-max-in-memory-events=")) {
      maxInMemoryEvents = parseNonNegativeIntegerOption(
        "--chat-max-in-memory-events",
        arg.slice("--chat-max-in-memory-events=".length),
      );
      continue;
    }
    throw new Error(`unsupported interactive chat stdio argument: ${arg}`);
  }
  return {
    ...(sessionDbPath !== undefined && sessionDbPath.trim() !== ""
      ? { sessionDbPath }
      : {}),
    ...(maxInMemoryEvents !== undefined ? { maxInMemoryEvents } : {}),
    help,
  };
};

const openSessionStore = async (
  sessionDbPath: string,
): Promise<HarnessChatSessionStore> => {
  const { openSqliteHarnessChatSessionStore } = await import(
    "./sqlite-session-store.ts"
  );
  return await openSqliteHarnessChatSessionStore({
    url: toFileUrl(resolve(sessionDbPath)),
  });
};

const SUPPORTED_REQUEST_METHODS = new Set<HarnessChatRequestMethod>([
  "start_session",
  "start_turn",
  "cancel_turn",
  "close_session",
  "status",
  "list_events",
  "list_turns",
]);
const SUPPORTED_POLICY_TOOL_MODES = new Set(["workspace-write", "read-only"]);
const SUPPORTED_TURN_STATUSES = new Set([
  "running",
  "canceling",
  "canceled",
  "completed",
  "failed",
]);
const SUPPORTED_POLICY_TOOL_IDS = new Set<BuiltinToolId>([
  "bash",
  "bash-no-sandbox",
  "read_file",
  "view_image",
  "web_fetch",
  "read_skill_resource",
  "edit_file",
  "write_file",
  "delegate_task",
]);
const SUPPORTED_POLICY_SUBAGENT_PROFILES = new Set<HarnessSubagentProfile>(
  HARNESS_SUBAGENT_PROFILES,
);
const SUPPORTED_CFC_ENFORCEMENT_MODES = new Set([
  "disabled",
  "observe",
  "enforce-explicit",
  "enforce-strict",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOptionalString = (
  value: Record<string, unknown>,
  key: string,
): boolean => value[key] === undefined || typeof value[key] === "string";

const hasOptionalStringIn = (
  value: Record<string, unknown>,
  key: string,
  allowedValues: readonly string[],
): boolean =>
  value[key] === undefined ||
  (typeof value[key] === "string" && allowedValues.includes(value[key]));

const hasOptionalNonNegativeInteger = (
  value: Record<string, unknown>,
  key: string,
): boolean =>
  value[key] === undefined ||
  (Number.isInteger(value[key]) && Number(value[key]) >= 0);

const hasOptionalPositiveInteger = (
  value: Record<string, unknown>,
  key: string,
): boolean =>
  value[key] === undefined ||
  (Number.isInteger(value[key]) && Number(value[key]) > 0);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isValidWorkspaceParam = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.hostPath === "string" &&
  hasOptionalString(value, "cwd") &&
  hasOptionalString(value, "sandboxPath");

const isValidTurnInputParam = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.text === "string" &&
  (value.imageAttachments === undefined ||
    Array.isArray(value.imageAttachments));

const isStringArrayIn = (
  value: unknown,
  allowedValues: ReadonlySet<string>,
): boolean =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && allowedValues.has(item));

const isValidPromptSlotParam = (value: unknown): boolean => {
  try {
    normalizePromptSlotBinding(value);
    return true;
  } catch {
    return false;
  }
};

const isValidBrowserAccessParam = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === HARNESS_BROWSER_ACCESS_LEASE_TYPE &&
  isNonEmptyString(value.leaseId) &&
  isNonEmptyString(value.cdpUrl) &&
  hasOptionalString(value, "owner") &&
  hasOptionalString(value, "expiresAt") &&
  hasOptionalStringIn(
    value,
    "profileMode",
    HARNESS_BROWSER_ACCESS_PROFILE_MODES,
  ) &&
  hasOptionalStringIn(
    value,
    "accountAccess",
    HARNESS_BROWSER_ACCESS_ACCOUNT_ACCESS,
  );

const isValidChatPolicyParam = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "cf-harness.chat-policy" &&
  typeof value.toolMode === "string" &&
  SUPPORTED_POLICY_TOOL_MODES.has(value.toolMode) &&
  isStringArrayIn(value.allowedToolIds, SUPPORTED_POLICY_TOOL_IDS) &&
  isStringArrayIn(
    value.allowedSubagentProfiles,
    SUPPORTED_POLICY_SUBAGENT_PROFILES,
  ) &&
  (value.cfcEnforcementMode === undefined ||
    (typeof value.cfcEnforcementMode === "string" &&
      SUPPORTED_CFC_ENFORCEMENT_MODES.has(value.cfcEnforcementMode))) &&
  (value.promptSlot === undefined ||
    isValidPromptSlotParam(value.promptSlot));

const isValidRequestParams = (
  method: HarnessChatRequestMethod,
  params: Record<string, unknown>,
): boolean => {
  switch (method) {
    case "start_session":
      return hasOptionalString(params, "sessionId") &&
        isValidWorkspaceParam(params.workspace) &&
        hasOptionalString(params, "model") &&
        hasOptionalString(params, "artifactRoot") &&
        (params.context === undefined || isRecord(params.context)) &&
        (params.policy === undefined ||
          isValidChatPolicyParam(params.policy)) &&
        (params.capabilities === undefined || isRecord(params.capabilities)) &&
        (params.browserAccess === undefined ||
          isValidBrowserAccessParam(params.browserAccess)) &&
        (params.metadata === undefined || isRecord(params.metadata));
    case "start_turn":
      return typeof params.sessionId === "string" &&
        hasOptionalString(params, "turnId") &&
        isValidTurnInputParam(params.input) &&
        (params.context === undefined || isRecord(params.context)) &&
        (params.policy === undefined ||
          isValidChatPolicyParam(params.policy)) &&
        (params.browserAccess === undefined ||
          isValidBrowserAccessParam(params.browserAccess)) &&
        (params.metadata === undefined || isRecord(params.metadata));
    case "cancel_turn":
      return typeof params.sessionId === "string" &&
        hasOptionalString(params, "turnId") &&
        hasOptionalString(params, "reason");
    case "close_session":
      return typeof params.sessionId === "string" &&
        hasOptionalString(params, "reason");
    case "status":
      return hasOptionalString(params, "sessionId");
    case "list_events":
      return hasOptionalString(params, "sessionId") &&
        hasOptionalNonNegativeInteger(params, "afterSequence") &&
        hasOptionalPositiveInteger(params, "limit");
    case "list_turns":
      return hasOptionalString(params, "sessionId") &&
        (params.status === undefined ||
          (typeof params.status === "string" &&
            SUPPORTED_TURN_STATUSES.has(params.status)));
  }
};

const isRequestEnvelope = (
  value: unknown,
): value is HarnessChatRequestEnvelope => {
  if (
    !isRecord(value) ||
    !("type" in value) ||
    value.type !== HARNESS_CHAT_REQUEST_TYPE ||
    !("protocolVersion" in value) ||
    value.protocolVersion !== HARNESS_CHAT_PROTOCOL_VERSION ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("method" in value) ||
    typeof value.method !== "string" ||
    !SUPPORTED_REQUEST_METHODS.has(value.method as HarnessChatRequestMethod) ||
    !("params" in value) ||
    !isRecord(value.params)
  ) {
    return false;
  }
  return isValidRequestParams(
    value.method as HarnessChatRequestMethod,
    value.params,
  );
};

const requestIdFromUnknown = (value: unknown): string =>
  isRecord(value) &&
    "requestId" in value &&
    typeof value.requestId === "string"
    ? value.requestId
    : "invalid";

const parseRequestLine = (line: string): HarnessChatRequestEnvelope => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw invalidRequestResponse(
      `failed to parse chat request JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRequestEnvelope(parsed)) {
    throw invalidRequestResponse(
      "chat request envelope is malformed or has unsupported protocolVersion",
      requestIdFromUnknown(parsed),
    );
  }
  return parsed;
};

export const runHarnessInteractiveChatNdjsonTransport = async (
  options: RunHarnessInteractiveChatNdjsonTransportOptions,
): Promise<void> => {
  const writeEnvelope = async (
    envelope: HarnessInteractiveChatOutputEnvelope,
  ): Promise<void> => {
    await options.writeLine(JSON.stringify(envelope));
  };
  const service = options.createService?.(writeEnvelope) ??
    createHarnessInteractiveChatService({
      onEvent: writeEnvelope,
    });
  const resolvedService = await service;

  let transportError: unknown;
  let cleanupError: unknown;
  try {
    for await (const rawLine of options.lines) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      let response: HarnessChatResponse;
      try {
        response = await resolvedService.handleRequest(parseRequestLine(line));
      } catch (error) {
        response = isTransportErrorResponse(error)
          ? error
          : invalidRequestResponse(
            error instanceof Error ? error.message : String(error),
          );
      }
      await writeEnvelope(response);
    }
  } catch (error) {
    transportError = error;
  } finally {
    try {
      await resolvedService.waitForIdle();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await options.closeService?.(resolvedService);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (transportError !== undefined) {
    throw transportError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
};

const isTransportErrorResponse = (
  value: unknown,
): value is HarnessChatResponse =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "type" in value &&
  value.type === HARNESS_CHAT_RESPONSE_TYPE &&
  "ok" in value &&
  value.ok === false;

const decodeUtf8Lines = async function* (
  input: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
};

export const runHarnessInteractiveChatStdio = async (
  options: RunHarnessInteractiveChatStdioOptions = {},
): Promise<void> => {
  const encoder = new TextEncoder();
  const output = options.output ?? Deno.stdout.writable;
  const writer = output.getWriter();
  let sessionStore: HarnessChatSessionStore | undefined;
  const createService = options.createService ??
    (async (
      onEvent: (event: HarnessChatEventEnvelope) => void | Promise<void>,
    ) => {
      let openedStore: HarnessChatSessionStore | undefined;
      try {
        if (options.sessionDbPath !== undefined) {
          openedStore = await openSessionStore(options.sessionDbPath);
          sessionStore = openedStore;
        }
        const service = createHarnessInteractiveChatService({
          onEvent,
          ...(options.basePromptLoopOptions !== undefined
            ? { basePromptLoopOptions: options.basePromptLoopOptions }
            : {}),
          ...(options.createPromptLoop !== undefined
            ? { createPromptLoop: options.createPromptLoop }
            : {}),
          ...(sessionStore !== undefined ? { sessionStore } : {}),
          ...(options.maxInMemoryEvents !== undefined
            ? { maxInMemoryEvents: options.maxInMemoryEvents }
            : {}),
        });
        await service.initializeFromStore();
        return service;
      } catch (error) {
        await openedStore?.close?.();
        if (sessionStore === openedStore) {
          sessionStore = undefined;
        }
        throw error;
      }
    });
  try {
    await runHarnessInteractiveChatNdjsonTransport({
      lines: decodeUtf8Lines(options.input ?? Deno.stdin.readable),
      createService,
      closeService: async () => {
        await sessionStore?.close?.();
      },
      writeLine: async (line) => {
        await writer.write(encoder.encode(`${line}\n`));
      },
    });
  } finally {
    writer.releaseLock();
  }
};

export const runHarnessInteractiveChatStdioCli = async (
  args: readonly string[] = Deno.args,
): Promise<void> => {
  const options = parseHarnessInteractiveChatStdioCliOptions(args);
  if (options.help) {
    await Deno.stderr.write(new TextEncoder().encode(usageText));
    return;
  }
  await runHarnessInteractiveChatStdio(options);
};

if (import.meta.main) {
  try {
    await runHarnessInteractiveChatStdioCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

import { resolve, toFileUrl } from "@std/path";
import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";
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
import { resolveInteractiveProvisioning } from "./host-mounts.ts";
import { BUILTIN_TOOLS } from "./tools/registry.ts";
import {
  createHarnessInteractiveChatService,
  type HarnessInteractiveChatService,
  type HarnessInteractivePromptLoopFactory,
} from "./interactive-chat-service.ts";
import type { HarnessChatSessionStore } from "./session-store.ts";
import type { CreateHarnessPromptLoopOptions } from "./prompt-loop.ts";
import type { HarnessCredentialOwnerRef } from "./contracts/run-manifest.ts";

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
  /** Single authenticated owner for an owner-bound service process. */
  credentialOwner?: HarnessCredentialOwnerRef;
  createPromptLoop?: HarnessInteractivePromptLoopFactory;
  createService?: (
    onEvent: (event: HarnessChatEventEnvelope) => void | Promise<void>,
  ) => HarnessInteractiveChatService | Promise<HarnessInteractiveChatService>;
}

export interface HarnessInteractiveChatStdioCliOptions {
  sessionDbPath?: string;
  maxInMemoryEvents?: number;
  /**
   * Raw `--host-mount` specs, in the batch CLI's grammar, left unresolved.
   *
   * Resolution is async (it realpaths and stats each source) and this parser is
   * sync, so the caller hands these to `parseHostMountSpecs` from
   * ./host-mounts.ts. The grammar and its validation are shared with the batch
   * entrypoint deliberately: provisioning a chat session must not require
   * learning a second mount vocabulary.
   */
  hostMountSpecs?: readonly string[];
  maxModelTurns?: number;
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
  --host-mount <spec>                  Extra host bind mount, same grammar as the batch CLI
                                       (repeatable: name=<id>,source=<host>,target=<sandbox>,mode=readonly|writable)
  --max-model-turns <count>            Model turns allowed per user message (default 8)
  --help                              Print this help text to stderr

Environment:
  ${CHAT_SESSION_DB_ENV}                 Default SQLite chat session DB path
  ${CHAT_MAX_IN_MEMORY_EVENTS_ENV}       Default in-memory event retention cap
`;

export const harnessInteractiveChatStdioUsageText = (): string => usageText;

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

const parsePositiveIntegerOption = (
  name: string,
  value: string | undefined,
): number => {
  const parsed = parseNonNegativeIntegerOption(name, value);
  if (parsed === 0) {
    throw new Error(`${name} requires a positive integer value`);
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
  const hostMountSpecs: string[] = [];
  let maxModelTurns: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--host-mount") {
      index += 1;
      hostMountSpecs.push(nonEmptyOptionValue(arg, args[index]));
      continue;
    }
    if (arg.startsWith("--host-mount=")) {
      hostMountSpecs.push(
        nonEmptyOptionValue("--host-mount", arg.slice("--host-mount=".length)),
      );
      continue;
    }
    if (arg === "--max-model-turns") {
      index += 1;
      maxModelTurns = parsePositiveIntegerOption(arg, args[index]);
      continue;
    }
    if (arg.startsWith("--max-model-turns=")) {
      maxModelTurns = parsePositiveIntegerOption(
        "--max-model-turns",
        arg.slice("--max-model-turns=".length),
      );
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
    ...(hostMountSpecs.length > 0 ? { hostMountSpecs } : {}),
    ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
    help,
  };
};

const openSessionStore = async (
  sessionDbPath: string,
): Promise<HarnessChatSessionStore> => {
  // The SQLite session store opens its native library as it loads, and only a
  // session-backed run needs it.
  // deno-lint-ignore cf-imports/no-inline-module-import
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
// Every tool the harness defines, taken from the registry that defines them:
// a client naming a tool this build offers is submitting a policy this build
// can honour, and a second list here would refuse one the run advertises.
const SUPPORTED_POLICY_TOOL_IDS = new Set<BuiltinToolId>(
  BUILTIN_TOOLS.map((tool) => tool.descriptor.toolId),
);
const SUPPORTED_POLICY_SUBAGENT_PROFILES = new Set<HarnessSubagentProfile>(
  HARNESS_SUBAGENT_PROFILES,
);
const SUPPORTED_CFC_ENFORCEMENT_MODES = new Set([
  "disabled",
  "observe",
  "enforce-explicit",
  "enforce-strict",
]);

const hasOptionalString = (
  value: ReadonlyRecord,
  key: string,
): boolean => value[key] === undefined || typeof value[key] === "string";

const hasOptionalStringIn = (
  value: ReadonlyRecord,
  key: string,
  allowedValues: readonly string[],
): boolean =>
  value[key] === undefined ||
  (typeof value[key] === "string" && allowedValues.includes(value[key]));

const hasOptionalNonNegativeInteger = (
  value: ReadonlyRecord,
  key: string,
): boolean =>
  value[key] === undefined ||
  (Number.isInteger(value[key]) && Number(value[key]) >= 0);

const hasOptionalPositiveInteger = (
  value: ReadonlyRecord,
  key: string,
): boolean =>
  value[key] === undefined ||
  (Number.isInteger(value[key]) && Number(value[key]) > 0);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isValidWorkspaceParam = (value: unknown): boolean =>
  isObjectNotArray(value) &&
  typeof value.hostPath === "string" &&
  hasOptionalString(value, "cwd") &&
  hasOptionalString(value, "sandboxPath");

const isValidTurnInputParam = (value: unknown): boolean =>
  isObjectNotArray(value) &&
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
  isObjectNotArray(value) &&
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
  isObjectNotArray(value) &&
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
  params: ReadonlyRecord,
): boolean => {
  switch (method) {
    case "start_session":
      return hasOptionalString(params, "sessionId") &&
        isValidWorkspaceParam(params.workspace) &&
        hasOptionalString(params, "model") &&
        hasOptionalString(params, "artifactRoot") &&
        (params.context === undefined || isObjectNotArray(params.context)) &&
        (params.policy === undefined ||
          isValidChatPolicyParam(params.policy)) &&
        (params.capabilities === undefined ||
          isObjectNotArray(params.capabilities)) &&
        (params.browserAccess === undefined ||
          isValidBrowserAccessParam(params.browserAccess)) &&
        (params.metadata === undefined || isObjectNotArray(params.metadata));
    case "start_turn":
      return typeof params.sessionId === "string" &&
        hasOptionalString(params, "turnId") &&
        isValidTurnInputParam(params.input) &&
        (params.context === undefined || isObjectNotArray(params.context)) &&
        (params.policy === undefined ||
          isValidChatPolicyParam(params.policy)) &&
        (params.browserAccess === undefined ||
          isValidBrowserAccessParam(params.browserAccess)) &&
        (params.metadata === undefined || isObjectNotArray(params.metadata));
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
    !isObjectNotArray(value) ||
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
    !isObjectNotArray(value.params)
  ) {
    return false;
  }
  return isValidRequestParams(
    value.method as HarnessChatRequestMethod,
    value.params,
  );
};

const requestIdFromUnknown = (value: unknown): string =>
  isObjectNotArray(value) &&
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
  isObjectNotArray(value) &&
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
          ...(options.credentialOwner !== undefined
            ? { credentialOwner: options.credentialOwner }
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
  cwd?: string,
  /** Seam for tests: observe the options this entrypoint actually forwards. */
  run: (
    options: RunHarnessInteractiveChatStdioOptions,
  ) => Promise<void> = runHarnessInteractiveChatStdio,
): Promise<void> => {
  const options = parseHarnessInteractiveChatStdioCliOptions(args);
  if (options.help) {
    await Deno.stderr.write(
      new TextEncoder().encode(harnessInteractiveChatStdioUsageText()),
    );
    return;
  }
  // Advertised flags must take effect on this entrypoint too. Resolved through
  // the same helper the Loom-local host uses, so the two cannot drift.
  const provisioning = await resolveInteractiveProvisioning(
    options,
    cwd ?? Deno.cwd(),
  );
  await run({
    ...options,
    ...(Object.keys(provisioning).length > 0
      ? { basePromptLoopOptions: provisioning }
      : {}),
  });
};

if (import.meta.main) {
  try {
    await runHarnessInteractiveChatStdioCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}

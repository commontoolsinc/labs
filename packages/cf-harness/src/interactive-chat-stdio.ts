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
  createHarnessInteractiveChatService,
  type HarnessInteractiveChatService,
} from "./interactive-chat-service.ts";

export type HarnessInteractiveChatOutputEnvelope =
  | HarnessChatEventEnvelope
  | HarnessChatResponse;

export interface RunHarnessInteractiveChatNdjsonTransportOptions {
  lines: AsyncIterable<string> | Iterable<string>;
  writeLine: (line: string) => void | Promise<void>;
  createService?: (
    onEvent: (event: HarnessChatEventEnvelope) => void | Promise<void>,
  ) => HarnessInteractiveChatService;
}

const invalidRequestResponse = (
  message: string,
  requestId = "invalid",
): HarnessChatResponse =>
  createHarnessChatErrorResponse(requestId, {
    code: "invalid_request",
    message,
  });

const SUPPORTED_REQUEST_METHODS = new Set<HarnessChatRequestMethod>([
  "start_session",
  "start_turn",
  "cancel_turn",
  "close_session",
  "status",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOptionalString = (
  value: Record<string, unknown>,
  key: string,
): boolean => value[key] === undefined || typeof value[key] === "string";

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
        (params.policy === undefined || isRecord(params.policy)) &&
        (params.capabilities === undefined || isRecord(params.capabilities)) &&
        (params.browserAccess === undefined ||
          isRecord(params.browserAccess)) &&
        (params.metadata === undefined || isRecord(params.metadata));
    case "start_turn":
      return typeof params.sessionId === "string" &&
        hasOptionalString(params, "turnId") &&
        isValidTurnInputParam(params.input) &&
        (params.context === undefined || isRecord(params.context)) &&
        (params.policy === undefined || isRecord(params.policy)) &&
        (params.browserAccess === undefined ||
          isRecord(params.browserAccess)) &&
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

  for await (const rawLine of options.lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let response: HarnessChatResponse;
    try {
      response = await service.handleRequest(parseRequestLine(line));
    } catch (error) {
      response = isTransportErrorResponse(error)
        ? error
        : invalidRequestResponse(
          error instanceof Error ? error.message : String(error),
        );
    }
    await writeEnvelope(response);
  }
  await service.waitForIdle();
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
  options: {
    input?: ReadableStream<Uint8Array>;
    output?: WritableStream<Uint8Array>;
    createService?: (
      onEvent: (event: HarnessChatEventEnvelope) => void | Promise<void>,
    ) => HarnessInteractiveChatService;
  } = {},
): Promise<void> => {
  const encoder = new TextEncoder();
  const output = options.output ?? Deno.stdout.writable;
  const writer = output.getWriter();
  try {
    await runHarnessInteractiveChatNdjsonTransport({
      lines: decodeUtf8Lines(options.input ?? Deno.stdin.readable),
      createService: options.createService,
      writeLine: async (line) => {
        await writer.write(encoder.encode(`${line}\n`));
      },
    });
  } finally {
    writer.releaseLock();
  }
};

if (import.meta.main) {
  await runHarnessInteractiveChatStdio();
}

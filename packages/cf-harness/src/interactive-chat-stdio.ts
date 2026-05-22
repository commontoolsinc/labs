import {
  createHarnessChatErrorResponse,
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_RESPONSE_TYPE,
  type HarnessChatEventEnvelope,
  type HarnessChatRequestEnvelope,
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

const isRequestEnvelope = (
  value: unknown,
): value is HarnessChatRequestEnvelope =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "protocolVersion" in value &&
  value.protocolVersion === HARNESS_CHAT_PROTOCOL_VERSION &&
  "requestId" in value &&
  typeof value.requestId === "string" &&
  "method" in value &&
  typeof value.method === "string" &&
  "params" in value &&
  typeof value.params === "object" &&
  value.params !== null &&
  !Array.isArray(value.params);

const requestIdFromUnknown = (value: unknown): string =>
  typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
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

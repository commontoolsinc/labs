import {
  compatibleMemoryProtocolFlags,
  getMemoryProtocolFlags,
  type HelloMessage,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type MemoryProtocolFlags,
  parseMemoryProtocolFlags,
  type RequestSchemaCasMetadata,
  type ServerMessage,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";

type TypedError = {
  name: string;
  message: string;
};

const toError = (name: string, message: string): TypedError => ({
  name,
  message,
});

export interface ServerHelloOptions {
  flags?: MemoryProtocolFlags;
  requestSchemaCas?: RequestSchemaCasMetadata;
}

export const respondToHello = (
  message: HelloMessage,
  options: ServerHelloOptions = {},
): ServerMessage => {
  const expectedFlags = options.flags ?? getMemoryProtocolFlags();
  if (message.protocol !== MEMORY_PROTOCOL) {
    return {
      type: "response",
      requestId: "handshake",
      error: toError(
        "UnsupportedProtocol",
        `Unsupported protocol: ${message.protocol}`,
      ),
    };
  }
  const parsed = parseMemoryProtocolFlags(message.flags);
  if (
    parsed === null ||
    !compatibleMemoryProtocolFlags(parsed, expectedFlags)
  ) {
    return {
      type: "response",
      requestId: "handshake",
      error: toError(
        "ProtocolError",
        `memory flag mismatch: client=${
          toCompactDebugString(message.flags)
        } server=${toCompactDebugString(expectedFlags)}`,
      ),
    };
  }

  const response: HelloOkMessage = {
    type: "hello.ok",
    protocol: MEMORY_PROTOCOL,
    flags: wireMemoryProtocolFlags(expectedFlags),
    ...(expectedFlags.requestSchemaCasV1 === true &&
        options.requestSchemaCas !== undefined
      ? { requestSchemaCas: options.requestSchemaCas }
      : {}),
  };
  return response;
};

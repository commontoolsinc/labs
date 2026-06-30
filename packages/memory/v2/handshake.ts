import {
  compatibleMemoryProtocolFlags,
  getMemoryProtocolFlags,
  type HelloMessage,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
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

export const respondToHello = (message: HelloMessage): ServerMessage => {
  const expectedFlags = getMemoryProtocolFlags();
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
  };
  return response;
};

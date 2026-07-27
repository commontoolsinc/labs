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

type IncomingHelloMessage =
  & Omit<HelloMessage, "protocol" | "flags">
  & {
    protocol: unknown;
    flags: unknown;
  };

/**
 * Returns `null` when the peer speaks a different protocol version. Callers
 * must drop the connection without sending a response in that case.
 */
export const respondToHello = (
  message: IncomingHelloMessage,
): ServerMessage | null => {
  if (message.protocol !== MEMORY_PROTOCOL) {
    return null;
  }
  const expectedFlags = getMemoryProtocolFlags();
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

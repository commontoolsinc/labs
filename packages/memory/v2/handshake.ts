import {
  getMemoryProtocolFlags,
  type HelloMessage,
  MEMORY_PROTOCOL,
  sameMemoryProtocolFlags,
  type ServerMessage,
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
  if (!sameMemoryProtocolFlags(message.flags, expectedFlags)) {
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
  return {
    type: "hello.ok",
    protocol: MEMORY_PROTOCOL,
    flags: expectedFlags,
  };
};

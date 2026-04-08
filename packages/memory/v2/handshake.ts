import {
  getMemoryV2Flags,
  type HelloMessage,
  MEMORY_V2_PROTOCOL,
  sameMemoryV2Flags,
  type ServerMessage,
} from "../v2.ts";

type TypedError = {
  name: string;
  message: string;
};

const toError = (name: string, message: string): TypedError => ({
  name,
  message,
});

export const respondToHello = (message: HelloMessage): ServerMessage => {
  const expectedFlags = getMemoryV2Flags();
  if (message.protocol !== MEMORY_V2_PROTOCOL) {
    return {
      type: "response",
      requestId: "handshake",
      error: toError(
        "UnsupportedProtocol",
        `Unsupported protocol: ${message.protocol}`,
      ),
    };
  }
  if (!sameMemoryV2Flags(message.flags, expectedFlags)) {
    return {
      type: "response",
      requestId: "handshake",
      error: toError(
        "ProtocolError",
        `memory/v2 flag mismatch: client=${
          JSON.stringify(message.flags)
        } server=${JSON.stringify(expectedFlags)}`,
      ),
    };
  }
  return {
    type: "hello.ok",
    protocol: MEMORY_V2_PROTOCOL,
    flags: expectedFlags,
  };
};

class DisconnectedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  constructor(_url: string | URL) {
    throw new DOMException(
      "Test WebSocket connections are disabled",
      "NetworkError",
    );
  }
}

export function installDisconnectedWebSocket(): () => void {
  const original = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    DisconnectedWebSocket as unknown as typeof WebSocket;
  return () => {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      original;
  };
}

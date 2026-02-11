/**
 * V2 Provider Connection - WebSocket transport for v2 memory protocol.
 *
 * Opens a WebSocket to the v2 endpoint, sends JSON-encoded commands,
 * and dispatches incoming messages (receipts + subscription updates)
 * back to the V2Provider.
 *
 * Reconnection follows the same back-off pattern as the v1
 * ProviderConnection.
 *
 * @module v2-provider-connection
 */

import { getLogger } from "@commontools/utils/logger";
import type { SpaceId } from "@commontools/memory/v2-types";

const logger = getLogger("storage.v2-connection", {
  enabled: true,
  level: "error",
});

// ---------------------------------------------------------------------------
// Message handler callback
// ---------------------------------------------------------------------------

/**
 * Callback invoked for every JSON message received from the server.
 */
export type OnMessage = (message: unknown) => void;

/**
 * Callback invoked when the connection opens (or re-opens).
 */
export type OnOpen = () => void;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface V2ProviderConnectionOptions {
  /** Base URL of the memory service (e.g. `https://host/api/storage/memory`). */
  address: URL;

  /** Space to connect to. */
  spaceId: SpaceId;

  /** Handler for incoming server messages. */
  onMessage: OnMessage;

  /** Handler for connection open events. */
  onOpen: OnOpen;

  /** Timeout (ms) before retrying a stalled connection. */
  connectionTimeout: number;
}

// ---------------------------------------------------------------------------
// V2ProviderConnection
// ---------------------------------------------------------------------------

export class V2ProviderConnection {
  readonly address: URL;
  readonly spaceId: SpaceId;

  private socket: WebSocket | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private connectionCount = 0;
  private hasConnectedSuccessfully = false;
  private _onMessage: OnMessage;
  private _onOpen: OnOpen;
  private connectionTimeout: number;

  /** Commands queued while the socket is not open. */
  private queue: string[] = [];

  constructor(options: V2ProviderConnectionOptions) {
    this.address = options.address;
    this.spaceId = options.spaceId;
    this._onMessage = options.onMessage;
    this._onOpen = options.onOpen;
    this.connectionTimeout = options.connectionTimeout;

    this.handleEvent = this.handleEvent.bind(this);
    this.connect();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Send a v2 command over the WebSocket. If the socket is not yet open
   * the message is queued and flushed when the connection opens.
   */
  send(command: unknown): void {
    const json = JSON.stringify(command);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(json);
    } else {
      this.queue.push(json);
    }
  }

  /**
   * True when the underlying WebSocket is in the OPEN state.
   */
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Close the connection permanently (no reconnect).
   */
  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.clearTimeout();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.removeEventListener("message", this);
      socket.removeEventListener("open", this);
      socket.removeEventListener("close", this);
      socket.removeEventListener("error", this);
      socket.close();
      await V2ProviderConnection.closed(socket);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Connection lifecycle
  // -------------------------------------------------------------------------

  private connect(): void {
    // Clean up prior socket if any.
    if (this.socket) {
      this.clearTimeout();
      this.socket.removeEventListener("message", this);
      this.socket.removeEventListener("open", this);
      this.socket.removeEventListener("close", this);
      this.socket.removeEventListener("error", this);
    }

    const url = new URL(this.address.href);
    url.searchParams.set("space", this.spaceId);

    const socket = new WebSocket(url.href);
    this.socket = socket;
    this.connectionCount += 1;

    // Start connection timeout.
    this.startTimeout();

    socket.addEventListener("message", this);
    socket.addEventListener("open", this);
    socket.addEventListener("close", this);
    socket.addEventListener("error", this);
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  handleEvent(
    event: Event & { type: string; data?: string; target?: unknown },
  ): void {
    this.clearTimeout();
    switch (event.type) {
      case "message":
        return this.onReceive((event as MessageEvent).data);
      case "open":
        return this.onSocketOpen();
      case "close":
      case "error":
        return this.onDisconnect(event);
      case "timeout":
        return this.onTimeout(event.target as WebSocket);
    }
  }

  private onReceive(data: string): void {
    try {
      const message = JSON.parse(data);
      this._onMessage(message);
    } catch (err) {
      logger.error("v2-parse-error", () => [
        `Failed to parse v2 message: ${err}`,
      ]);
    }
  }

  private onSocketOpen(): void {
    logger.debug("v2-connected", () => [
      `v2 WebSocket connected (attempt ${this.connectionCount})`,
    ]);

    // Flush queued commands.
    for (const json of this.queue) {
      this.socket!.send(json);
    }
    this.queue = [];

    const isReconnect = this.hasConnectedSuccessfully;
    this.hasConnectedSuccessfully = true;

    // Notify the provider so it can (re)establish subscriptions.
    if (isReconnect) {
      queueMicrotask(() => this._onOpen());
    } else {
      this._onOpen();
    }
  }

  private onDisconnect(event: Event): void {
    if (this.socket === (event.target as WebSocket)) {
      logger.debug("v2-disconnected", () => [
        `v2 WebSocket disconnected (${event.type}), reconnecting...`,
      ]);
      this.connect();
    }
  }

  private onTimeout(socket: WebSocket): void {
    logger.debug("v2-timeout", () => [
      `v2 WebSocket connection timed out after ${this.connectionTimeout}ms`,
    ]);
    if (this.socket === socket) {
      socket.close();
    }
  }

  // -------------------------------------------------------------------------
  // Timeout helpers
  // -------------------------------------------------------------------------

  private startTimeout(): void {
    this.timeoutId = setTimeout(
      this.handleEvent,
      this.connectionTimeout,
      { type: "timeout", target: this.socket },
    );
  }

  private clearTimeout(): void {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Static helpers
  // -------------------------------------------------------------------------

  private static closed(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.addEventListener("error", (e) => reject(e), { once: true });
    });
  }
}

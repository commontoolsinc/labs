import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  MemoryMessageCompressionChannel,
  type MemoryMessageFrame,
  memoryMessageFrameBytes,
} from "@commonfabric/memory/v2/message-compression";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";

import type * as Routes from "./memory.routes.ts";
import { formatMemWriteTrace, type MemWriteOp } from "./memwrite-trace.ts";
import env from "@/env.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import { createSpan } from "@/middlewares/opentelemetry.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

type NegotiatedSocketHandlers = {
  onMessage: (message: MemoryMessageFrame) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

type NegotiationOptions = {
  maxBufferedBytes?: number;
};

const NEGOTIATION_BUFFER_MAX_BYTES = 1_048_576;
const TEXT_ENCODER = new TextEncoder();

export const bufferTextMessagesUntilNegotiated = (
  socket: WebSocket,
  options: NegotiationOptions = {},
): {
  firstMessage: Promise<string | undefined>;
  handoff: (handlers: NegotiatedSocketHandlers) => void;
  dispose: () => void;
} => {
  const maxBufferedBytes = options.maxBufferedBytes ??
    NEGOTIATION_BUFFER_MAX_BYTES;
  socket.binaryType = "arraybuffer";
  let settled = false;
  let bufferedMessages: MemoryMessageFrame[] = [];
  let bufferedBytes = 0;
  let cleanup = () => {};
  let handlers: NegotiatedSocketHandlers | null = null;
  let negotiationError: Error | null = null;

  const forwardMessage = (message: MemoryMessageFrame) => {
    if (handlers === null) {
      if (negotiationError !== null) {
        return;
      }
      const messageBytes = memoryMessageFrameBytes(message);
      if (bufferedBytes + messageBytes > maxBufferedBytes) {
        negotiationError = new Error(
          "Memory websocket negotiation buffer exceeded",
        );
        bufferedMessages = [];
        bufferedBytes = 0;
        try {
          socket.close(1009, negotiationError.message);
        } catch {
          // Ignore close races with the peer.
        }
        return;
      }
      bufferedBytes += messageBytes;
      bufferedMessages.push(message);
      return;
    }
    handlers.onMessage(message);
  };

  const firstMessage = new Promise<string | undefined>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const frame = event.data;
      const supportedFrame = typeof frame === "string" ||
        frame instanceof ArrayBuffer || frame instanceof Uint8Array ||
        frame instanceof Blob;
      if (!supportedFrame || (!settled && typeof frame !== "string")) {
        const error = new Error(
          settled
            ? "Memory websocket expects text or binary frames"
            : "Memory websocket expects text before negotiation",
        );
        if (!settled) {
          cleanup();
          reject(error);
        } else {
          handlers?.onError?.(error);
        }
        return;
      }

      if (!settled) {
        settled = true;
        resolve(frame as string);
        return;
      }

      forwardMessage(frame);
    };

    const onClose = () => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(undefined);
        return;
      }
      handlers?.onClose?.();
    };

    const onError = () => {
      cleanup();
      if (!settled) {
        reject(new Error("Memory websocket failed before negotiation"));
        return;
      }
      handlers?.onError?.(new Error("Memory websocket receive failure"));
    };

    cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });

  return {
    firstMessage,
    handoff(nextHandlers) {
      handlers = nextHandlers;
      if (negotiationError !== null) {
        nextHandlers.onError?.(negotiationError);
        return;
      }
      const queued = bufferedMessages;
      bufferedMessages = [];
      bufferedBytes = 0;
      for (const message of queued) {
        nextHandlers.onMessage(message);
      }
    },
    dispose: cleanup,
  };
};

// Per-connection ordinal for the gated `CF_DEBUG_MEMORY_WRITES` trace. Each
// WebSocket connection is one client, so tagging every `[memwrite]` line with
// this `c=<n>` attributes a write storm to specific clients. See
// `memwrite-trace.ts`.
let memwriteConnSeq = 0;

const frameSizeLogger = getLogger("memory-socket", {
  enabled: true,
  level: "warn",
});

// Deno's WebSocket client rejects any incoming message over 64 MiB
// ("Frame too large") and closes the connection, so an outbound frame
// approaching that cap is an outage in the making, not a curiosity — and a
// payload regression looks like timeouts from the outside (labs#6319).
// Warning at a quarter of the cap surfaces the growth while every client
// still loads. The cap is in bytes, so the check measures encoded bytes;
// a string's UTF-8 byte length falls in [length, 3 × length], and the
// cheap code-unit bound spares ordinary frames the encode pass.
const OUTBOUND_FRAME_WARN_BYTES = 16 * 1024 * 1024;

export const warnOnOversizedOutboundFrame = (
  encoded: string,
  message: unknown,
  warnBytes: number = OUTBOUND_FRAME_WARN_BYTES,
  warn: (key: string, lazyArgs: () => unknown[]) => void = (key, lazyArgs) =>
    frameSizeLogger.warn(key, lazyArgs),
): void => {
  if (encoded.length * 3 <= warnBytes) {
    return;
  }
  const frameBytes = TEXT_ENCODER.encode(encoded).byteLength;
  if (frameBytes <= warnBytes) {
    return;
  }
  warn("oversized-outbound-frame", () => [
    "outbound memory frame at",
    frameBytes,
    "bytes approaches the 64 MiB client cap;",
    "type:",
    (message as { type?: string }).type ?? "unknown",
    "space:",
    (message as { space?: string }).space ?? "unknown",
  ]);
};

export const attachMemorySocketPipeline = (
  socket: WebSocket,
  negotiation: ReturnType<typeof bufferTextMessagesUntilNegotiated>,
  firstMessage: string,
): boolean => {
  const parsedFirstMessage = MemoryServer.parseClientMessage(firstMessage);
  if (parsedFirstMessage === null) {
    return false;
  }
  const compressionNegotiated = parsedFirstMessage.type === "hello" &&
    parsedFirstMessage.flags.messageCompressionV1 === true;

  const safeSocketClose = (code: number, reason: string) => {
    if (
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CLOSED
    ) {
      return;
    }
    try {
      socket.close(code, reason);
    } catch {
      // Ignore close races with the peer.
    }
  };
  let closed = false;
  const channel = new MemoryMessageCompressionChannel(
    (frame) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame);
      }
    },
    () => {
      safeSocketClose(1011, "Memory websocket message failure");
      closeConnection();
    },
  );
  const connection = memoryServer.connect((message) => {
    const encoded = encodeMemoryBoundary(message);
    warnOnOversizedOutboundFrame(encoded, message);
    channel.send(encoded);
    if (compressionNegotiated && message.type === "hello.ok") {
      channel.enable();
    }
  });
  function closeConnection(): void {
    if (closed) return;
    closed = true;
    channel.close();
    connection.close();
  }

  // Gated diagnostic write trace (off by default). `CF_DEBUG_MEMORY_WRITES=1`
  // logs one `[memwrite]` line per committed op, tagged with this connection's
  // `c=<n>` so a write storm can be attributed to specific clients;
  // `CF_DEBUG_MEMORY_WRITE_VALUES=1` additionally dumps raw values (avoid on
  // real data — see memwrite-trace.ts).
  const debugMemWrites = Deno.env.get("CF_DEBUG_MEMORY_WRITES") === "1";
  const debugMemWriteValues =
    Deno.env.get("CF_DEBUG_MEMORY_WRITE_VALUES") === "1";
  const memConnId = debugMemWrites ? ++memwriteConnSeq : 0;
  const logMemWrites = (payload: string): void => {
    if (!debugMemWrites) return;
    try {
      const parsed = MemoryServer.parseClientMessage(payload) as unknown as {
        commit?: { operations?: Array<Record<string, unknown>> };
      };
      for (const op of parsed?.commit?.operations ?? []) {
        console.error(
          formatMemWriteTrace(op as MemWriteOp, memConnId, debugMemWriteValues),
        );
      }
    } catch {
      // Logging only.
    }
  };

  void (async () => {
    try {
      await connection.receive(firstMessage);
      logMemWrites(firstMessage);
      negotiation.handoff({
        onMessage(message) {
          if (closed) return;
          channel.receive(message, async (payload) => {
            await connection.receive(payload);
            logMemWrites(payload);
          });
        },
        onClose: closeConnection,
        onError(error) {
          safeSocketClose(
            error.message.startsWith("Memory websocket expects") ? 1003 : 1011,
            error.message,
          );
          closeConnection();
        },
      });
    } catch {
      safeSocketClose(1011, "Memory websocket setup failure");
      closeConnection();
    }
  })();

  return true;
};

export const subscribe: AppRouteHandler<typeof Routes.subscribe> = (c) => {
  return createSpan("memory.subscribe", (span) => {
    try {
      span.setAttribute("memory.operation", "subscribe");

      // The pong deadline must exceed the memory server's longest
      // synchronous busy stretch (frame evaluation, flush passes), not a
      // round-trip time: Deno's 30-second default closes every connection
      // on the process at once whenever the event loop is busy longer than
      // that, and the resulting reconnect stampede re-establishes each
      // session's full watch set against the same busy process.
      const { socket, response } = Deno.upgradeWebSocket(c.req.raw, {
        idleTimeout: env.MEMORY_WS_IDLE_TIMEOUT_SECONDS,
      });
      span.setAttribute("websocket.upgrade", "success");

      void createSpan("memory.socket.setup", async (setupSpan) => {
        const negotiation = bufferTextMessagesUntilNegotiated(socket);
        const firstMessage = await negotiation.firstMessage;
        if (firstMessage === undefined) {
          negotiation.dispose();
          setupSpan.setAttribute("socket.setup", "closed-before-message");
          return;
        }

        if (attachMemorySocketPipeline(socket, negotiation, firstMessage)) {
          setupSpan.setAttribute("socket.setup", "memory");
          return;
        }

        negotiation.dispose();
        setupSpan.setAttribute("socket.setup", "unsupported-protocol");
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1002, "Memory websocket expects memory protocol");
        }
      }).catch(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.close(1011, "Memory websocket setup failure");
          } catch {
            // Ignore close races with the peer.
          }
        }
      });

      return response;
    } catch (error) {
      span.setAttribute("memory.status", "exception");
      span.setAttribute(
        "error.message",
        error instanceof Error ? error.message : String(error),
      );
      span.setAttribute(
        "error.type",
        error instanceof Error ? error.name : "UnknownError",
      );
      throw error;
    }
  });
};

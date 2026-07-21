import type { AppRouteHandler } from "@/lib/types.ts";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import {
  MEMORY_WS_SERVER_INFLATE_MAX_BYTES,
  memoryWsDeflateEnabled,
  selectMemoryWsDeflateProtocol,
} from "@commonfabric/memory/v2/transport-deflate";
import {
  encodeMemoryWireFrameSync,
  inflateWirePayloadSync,
} from "@commonfabric/memory/v2/transport-deflate-sync";
import type * as Routes from "./memory.routes.ts";
import { memoryServer } from "../memory.ts";
import { createSpan } from "@/middlewares/opentelemetry.ts";
import { formatMemWriteTrace, type MemWriteOp } from "./memwrite-trace.ts";
import {
  createMemoryWsDeflateStatsRecorder,
  type MemoryWsDeflateStatsRecorder,
} from "./memory-ws-deflate-stats.ts";

type NegotiatedSocketHandlers = {
  onMessage: (message: string) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

type NegotiationOptions = {
  maxBufferedBytes?: number;
  /**
   * Present only when the connection negotiated `cf-memory.deflate.v1`. The codec is
   * deliberately SYNCHRONOUS: dispatch stays inside the message event
   * handler, so frame ordering, pre-close delivery, and nothing-after-close
   * remain event-loop properties rather than queue invariants. Absent, the
   * connection is text-only and binary frames are fatal.
   */
  inflateBinarySync?: (data: ArrayBuffer | ArrayBufferView) => string;
  /** Diagnostic: per-frame inbound byte accounting. */
  onFrame?: (
    wireBytes: number,
    logicalBytes: number,
    compressed: boolean,
    cpuMs?: number,
  ) => void;
};

const NEGOTIATION_BUFFER_MAX_BYTES = 1_048_576;
const TEXT_ENCODER = new TextEncoder();

/** Close codes for transport-level frame errors: 1003 for a frame type the
 * connection does not accept, 1007 for undecodable compressed data, 1011
 * otherwise. */
const closeCodeForSocketError = (error: Error): number =>
  error.message === "Memory websocket expects text frames"
    ? 1003
    : error.message === "Memory websocket inflate failure"
    ? 1007
    : 1011;

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
  let settled = false;
  let bufferedMessages: string[] = [];
  let bufferedBytes = 0;
  let cleanup = () => {};
  let handlers: NegotiatedSocketHandlers | null = null;
  let negotiationError: Error | null = null;
  let closePending = false;

  const forwardMessage = (message: string) => {
    if (handlers === null) {
      if (negotiationError !== null) {
        return;
      }
      const messageBytes = TEXT_ENCODER.encode(message).byteLength;
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
    const failFrame = (error: Error) => {
      if (!settled) {
        cleanup();
        reject(error);
        return;
      }
      if (handlers !== null) {
        handlers.onError?.(error);
        return;
      }
      // Settled but not handed off: fail the socket now and let handoff
      // deliver the error, instead of silently swallowing the frame.
      negotiationError = error;
      try {
        socket.close(closeCodeForSocketError(error), error.message);
      } catch {
        // Ignore close races with the peer.
      }
    };

    const dispatchText = (text: string) => {
      if (!settled) {
        settled = true;
        resolve(text);
        return;
      }
      forwardMessage(text);
    };

    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === "string") {
        if (options.onFrame !== undefined) {
          const bytes = TEXT_ENCODER.encode(data).byteLength;
          options.onFrame(bytes, bytes, false);
        }
        dispatchText(data);
        return;
      }

      if (
        options.inflateBinarySync !== undefined &&
        (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
      ) {
        let text: string;
        try {
          const started = performance.now();
          text = options.inflateBinarySync(data);
          options.onFrame?.(
            data.byteLength,
            TEXT_ENCODER.encode(text).byteLength,
            true,
            performance.now() - started,
          );
        } catch {
          failFrame(new Error("Memory websocket inflate failure"));
          return;
        }
        dispatchText(text);
        return;
      }

      failFrame(new Error("Memory websocket expects text frames"));
    };

    const onClose = () => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(undefined);
        return;
      }
      if (handlers !== null) {
        handlers.onClose?.();
        return;
      }
      // Between settle and handoff: remember the close so handoff can
      // deliver it after flushing buffered messages.
      closePending = true;
    };

    const onError = () => {
      cleanup();
      if (!settled) {
        reject(new Error("Memory websocket failed before negotiation"));
        return;
      }
      if (handlers !== null) {
        handlers.onError?.(new Error("Memory websocket receive failure"));
        return;
      }
      // Settled but not handed off: surface the failure at handoff so the
      // memory connection is still torn down instead of leaking.
      negotiationError = new Error("Memory websocket receive failure");
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
      if (closePending) {
        nextHandlers.onClose?.();
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

const attachMemorySocketPipeline = (
  socket: WebSocket,
  negotiation: ReturnType<typeof bufferTextMessagesUntilNegotiated>,
  firstMessage: string,
  options: {
    /** compress outbound payloads (deflate subprotocol negotiated). */
    deflateOutbound?: boolean;
    stats?: MemoryWsDeflateStatsRecorder;
  } = {},
): boolean => {
  if (MemoryServer.parseClientMessage(firstMessage) === null) {
    return false;
  }

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
  const connection = memoryServer.connect((message) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    // The shared frame encoder owns the sender policy (compression off,
    // auth-bearing exemption, size threshold); teardown stays here, tied to
    // this server's close machinery. The codec is synchronous, so ordering
    // needs no queue.
    try {
      socket.send(encodeMemoryWireFrameSync(
        message,
        options.deflateOutbound === true,
        options.stats === undefined
          ? undefined
          : (wireBytes, logicalBytes, compressed, cpuMs) =>
            options.stats!.recordOutbound(
              wireBytes,
              logicalBytes,
              compressed,
              cpuMs,
            ),
      ));
    } catch {
      safeSocketClose(1011, "Memory websocket send failure");
      connection.close();
    }
  });
  // The connection processes receives through an ordered chain, and closing
  // drops chained-but-unstarted receives. Frames already handed to receive()
  // — including the handoff's buffered flush — must settle before the close,
  // or messages that arrived before the close event are silently discarded.
  let lastReceive: Promise<unknown> = Promise.resolve();
  const closeConnection = () => {
    void lastReceive.catch(() => undefined).finally(() => connection.close());
  };

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
          // Trace only after the receive resolves, so a message whose receive
          // fails (the fatal-error path below) is not logged as a write.
          const received = connection.receive(message);
          lastReceive = received;
          void received.then(
            () => logMemWrites(message),
            () => {
              safeSocketClose(1011, "Memory websocket receive failure");
              closeConnection();
            },
          );
        },
        onClose: closeConnection,
        onError(error) {
          safeSocketClose(closeCodeForSocketError(error), error.message);
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

      // transport-level compression rides the websocket subprotocol.
      // Selection is unconditional on the offer — refusing an offered
      // subprotocol fails the connection per RFC 6455 — while the env kill
      // switch only stops this server from compressing its own outbound.
      const deflateProtocol = selectMemoryWsDeflateProtocol(
        c.req.header("sec-websocket-protocol"),
      );
      const deflateOutbound = deflateProtocol !== undefined &&
        memoryWsDeflateEnabled();
      const { socket, response } = Deno.upgradeWebSocket(
        c.req.raw,
        deflateProtocol !== undefined ? { protocol: deflateProtocol } : {},
      );
      socket.binaryType = "arraybuffer";
      span.setAttribute("websocket.upgrade", "success");
      span.setAttribute("websocket.deflate", deflateProtocol !== undefined);

      const stats = createMemoryWsDeflateStatsRecorder(
        c.req.header("user-agent"),
        deflateProtocol !== undefined,
      );
      if (stats !== undefined) {
        socket.addEventListener("close", () => stats.flush(), { once: true });
      }

      void createSpan("memory.socket.setup", async (setupSpan) => {
        const negotiation = bufferTextMessagesUntilNegotiated(socket, {
          ...(deflateProtocol !== undefined
            ? {
              // The tighter server cap bounds pre-authorization synchronous
              // inflation on the shared event loop.
              inflateBinarySync: (data) =>
                inflateWirePayloadSync(
                  data,
                  MEMORY_WS_SERVER_INFLATE_MAX_BYTES,
                ),
            }
            : {}),
          ...(stats !== undefined
            ? {
              onFrame: (wireBytes, logicalBytes, compressed, cpuMs) =>
                stats.recordInbound(wireBytes, logicalBytes, compressed, cpuMs),
            }
            : {}),
        });
        const firstMessage = await negotiation.firstMessage;
        if (firstMessage === undefined) {
          negotiation.dispose();
          setupSpan.setAttribute("socket.setup", "closed-before-message");
          return;
        }

        if (
          attachMemorySocketPipeline(socket, negotiation, firstMessage, {
            deflateOutbound,
            ...(stats !== undefined ? { stats } : {}),
          })
        ) {
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

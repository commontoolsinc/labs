import type { AppRouteHandler } from "@/lib/types.ts";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import type * as Routes from "./memory.routes.ts";
import { memoryServer } from "../memory.ts";
import { createSpan } from "@/middlewares/opentelemetry.ts";

type NegotiatedSocketHandlers = {
  onMessage: (message: string) => void;
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
  let settled = false;
  let bufferedMessages: string[] = [];
  let bufferedBytes = 0;
  let cleanup = () => {};
  let handlers: NegotiatedSocketHandlers | null = null;
  let negotiationError: Error | null = null;

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
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        if (!settled) {
          cleanup();
          reject(new Error("Memory websocket expects text frames"));
        } else {
          handlers?.onError?.(
            new Error("Memory websocket expects text frames"),
          );
        }
        return;
      }

      if (!settled) {
        settled = true;
        resolve(event.data);
        return;
      }

      forwardMessage(event.data);
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

// Per-connection ordinal for CF_DEBUG_MEMORY_WRITES. Each WebSocket connection
// is one client (one browser profile), so tagging every `[memwrite]` with this
// `c=<n>` attributes a storm's writes to specific clients — e.g. whether two
// divergent link targets come from two distinct clients (per-client identity
// divergence) or one client alternating (a condition flip).
let memwriteConnSeq = 0;

const attachMemorySocketPipeline = (
  socket: WebSocket,
  negotiation: ReturnType<typeof bufferTextMessagesUntilNegotiated>,
  firstMessage: string,
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
    socket.send(encodeMemoryBoundary(message));
  });
  // CF_DEBUG_MEMORY_WRITES=1: per-commit write trace (id + scope), mirrors the
  // standalone server's logging. Server-side, so it sees every client's commits
  // — the fastest way to see which doc a storm actually keeps writing.
  //
  // It also emits, per op, a content hash (`vhash`) and a capped canonical
  // rendering (`val`) of the written value plus the changed sub-paths
  // (`paths`). The write-contention investigation needs this: a non-terminating
  // multi-client storm requires a hot entity whose committed value genuinely
  // keeps CHANGING (value-equal writes are already short-circuited client-side
  // before commit). Grouping a hot id's `vhash` over time discriminates the
  // root cause — alternating hashes ⇒ different clients write structurally
  // different values (e.g. divergent link serialization); a single stable hash
  // ⇒ the churn is not value-divergence. `vhash` is over a key-sorted
  // serialization so it tracks content (not key-order) equality, the way the
  // runtime's `valueEqual` does.
  const debugMemWrites = Deno.env.get("CF_DEBUG_MEMORY_WRITES") === "1";
  const memConnId = debugMemWrites ? ++memwriteConnSeq : 0;
  const stableStringify = (value: unknown): string => {
    const seen = new WeakSet<object>();
    const walk = (x: unknown): unknown => {
      if (x === null || typeof x !== "object") return x;
      if (seen.has(x as object)) return "[circular]";
      seen.add(x as object);
      if (Array.isArray(x)) return x.map(walk);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as Record<string, unknown>).sort()) {
        out[k] = walk((x as Record<string, unknown>)[k]);
      }
      return out;
    };
    try {
      return JSON.stringify(walk(value)) ?? "undefined";
    } catch {
      return String(value);
    }
  };
  // FNV-1a/32, stable across runs and processes (unlike object identity).
  const hash32 = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const logMemWrites = (payload: string): void => {
    if (!debugMemWrites) return;
    try {
      const parsed = MemoryServer.parseClientMessage(payload) as unknown as {
        commit?: { operations?: Array<Record<string, any>> };
      };
      for (const op of parsed?.commit?.operations ?? []) {
        // For `set`/`delete` the written value is `op.value`; for `patch` the
        // value lives inside the JSON-patch entries (`op.patches[*].value`),
        // and `op.value` is absent. Hash whichever is present so a patch's
        // value isn't silently dropped (the `paths` are extracted separately).
        const payload = op?.patches !== undefined ? op.patches : op?.value;
        const hasValue = payload !== undefined;
        const canon = hasValue ? stableStringify(payload) : "";
        const vhash = hasValue ? hash32(canon) : "--------";
        const paths = Array.isArray(op?.patches)
          ? op.patches
            .map((p: Record<string, any>) => p?.path)
            .filter((p: unknown) => p !== undefined)
            .slice(0, 4)
            .join(",")
          : "";
        console.error(
          `[memwrite] c=${memConnId} op=${op?.op} id=${
            String(op?.id).slice(0, 28)
          } scope=${
            op?.scope ?? "(space)"
          } vhash=${vhash} paths=[${paths}] val=${canon.slice(0, 600)}`,
        );
      }
    } catch {
      // Logging only.
    }
  };
  const closeConnection = () => {
    connection.close();
  };
  void (async () => {
    try {
      logMemWrites(firstMessage);
      await connection.receive(firstMessage);
      negotiation.handoff({
        onMessage(message) {
          logMemWrites(message);
          void connection.receive(message).catch(() => {
            safeSocketClose(1011, "Memory websocket receive failure");
            closeConnection();
          });
        },
        onClose: closeConnection,
        onError(error) {
          safeSocketClose(
            error.message === "Memory websocket expects text frames"
              ? 1003
              : 1011,
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

      const { socket, response } = Deno.upgradeWebSocket(c.req.raw);
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

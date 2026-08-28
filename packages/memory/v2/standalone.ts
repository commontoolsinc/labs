/**
 * Standalone in-process memory v2 server.
 *
 * Serves the same websocket protocol (and `session.open` signature
 * verification) as toolshed's `/api/storage/memory` route, on an ephemeral
 * localhost port with a non-persistent store. Several runtimes — including
 * ones in Deno Workers or subprocesses — can share one storage backend
 * without a toolshed process. Used by multi-runtime test harnesses
 * (`cf test` multi-user mode, packages/patterns integration tests).
 *
 * Deno-only (uses `Deno.serve`); keep this export path out of browser
 * bundles.
 */

import { Identity } from "@commonfabric/identity";

import { encodeMemoryBoundary, getMemoryProtocolFlags } from "../v2.ts";
import {
  encodeMemoryCompressionControlMessage,
  isMemoryMessageFrame,
  MemoryMessageCompressionChannel,
  parseMemoryCompressionControlMessage,
} from "./message-compression.ts";
import * as MemoryServer from "./server.ts";
import { verifySessionOpenAuthorization } from "./session-open-auth.ts";

const standaloneMemoryAudience = (await Identity.fromPassphrase(
  "common tools standalone memory audience",
)).did();

// Session.open verification is shared with toolshed's memory route. The
// standalone server advertises a stable audience DID and requires the
// connection challenge issued in `hello.ok`.
const authorizeSessionOpen = (
  message: Parameters<typeof verifySessionOpenAuthorization>[0],
  context: Parameters<typeof verifySessionOpenAuthorization>[1],
): Promise<string> => verifySessionOpenAuthorization(message, context);

let nextConnectionTag = 0;

export class StandaloneMemoryServer {
  #memory: MemoryServer.Server;
  #http: Deno.HttpServer;
  #channels: Set<MemoryMessageCompressionChannel>;
  readonly url: URL;

  private constructor(
    memory: MemoryServer.Server,
    http: Deno.HttpServer,
    channels: Set<MemoryMessageCompressionChannel>,
  ) {
    this.#memory = memory;
    this.#http = http;
    this.#channels = channels;
    const address = http.addr as Deno.NetAddr;
    this.url = new URL(`http://127.0.0.1:${address.port}/`);
  }

  static start(
    options: {
      /** Space ACL config, passed through to the memory server. Default:
       *  off (the historical wide-open behavior in-process tests expect). */
      acl?: {
        mode: MemoryServer.MemoryAclMode;
        serviceDids?: readonly string[];
      };
    } = {},
  ): StandaloneMemoryServer {
    const memory = new MemoryServer.Server({
      authorizeSessionOpen,
      sessionOpenAuth: {
        audience: standaloneMemoryAudience,
      },
      acl: options.acl,
    });
    const channels = new Set<MemoryMessageCompressionChannel>();
    const http = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (request) => {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("memory websocket endpoint", { status: 200 });
      }
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.binaryType = "arraybuffer";
      const connectionTag = nextConnectionTag++;
      let compressionNegotiated = false;
      let sawFirstMessage = false;
      let closed = false;
      const channel = new MemoryMessageCompressionChannel(
        (frame) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(frame);
          }
        },
        () => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "memory websocket message failure");
          }
          closeConnection();
        },
      );
      channels.add(channel);
      const connection = memory.connect((message) => {
        channel.send(encodeMemoryBoundary(message));
        if (compressionNegotiated && message.type === "hello.ok") {
          channel.enable();
        }
      });
      function closeConnection(): void {
        if (closed) return;
        closed = true;
        channel.close();
        channels.delete(channel);
        connection.close();
      }
      const debugWrites = Deno.env.get("CF_DEBUG_MEMORY_WRITES") === "1";
      socket.addEventListener("message", (event) => {
        const frame = event.data;
        if (!isMemoryMessageFrame(frame)) {
          socket.close(
            1003,
            "memory websocket expects text or binary frames",
          );
          closeConnection();
          return;
        }
        if (!sawFirstMessage) {
          if (typeof frame !== "string") {
            socket.close(
              1003,
              "memory websocket expects text before negotiation",
            );
            closeConnection();
            return;
          }
          sawFirstMessage = true;
          const first = MemoryServer.parseClientMessage(frame);
          compressionNegotiated = first?.type === "hello" &&
            first.flags.messageCompressionV1 === true &&
            getMemoryProtocolFlags().messageCompressionV1;
        } else if (!compressionNegotiated && typeof frame !== "string") {
          socket.close(
            1003,
            "memory websocket expects text without compression negotiation",
          );
          closeConnection();
          return;
        }
        if (closed) return;
        channel.receive(frame, async (payload) => {
          const control = parseMemoryCompressionControlMessage(payload);
          if (control) {
            const enabled = compressionNegotiated && control.enabled;
            channel.setSendCompressionEnabled(enabled);
            channel.send(encodeMemoryCompressionControlMessage({
              requestId: control.requestId,
              enabled,
            }));
            return;
          }
          await connection.receive(payload);
          if (debugWrites) {
            logCommitOperations(connectionTag, payload);
          }
        });
      });
      socket.addEventListener("close", closeConnection);
      socket.addEventListener("error", closeConnection);
      return response;
    });
    return new StandaloneMemoryServer(memory, http, channels);
  }

  /**
   * Drains received compression work, the underlying memory server, and sent
   * compression work in that order. Multi-runtime test harnesses call this as
   * the deterministic "the server has published everything" barrier in place
   * of a fixed delay.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.#channels].map((channel) => channel.idle()));
    await this.#memory.idle();
    await Promise.all([...this.#channels].map((channel) => channel.idle()));
  }

  async close(): Promise<void> {
    await this.#http.shutdown();
    await this.#memory.close();
  }
}

// Best-effort per-commit write tracing (CF_DEBUG_MEMORY_WRITES=1): one line
// per operation with id + scope, the fastest way to see which scope partition
// a client's writes actually land in.
function logCommitOperations(connectionTag: number, payload: string): void {
  try {
    const parsed = MemoryServer.parseClientMessage(payload) as unknown as {
      commit?: { operations?: Array<Record<string, any>> };
    };
    const operations = parsed?.commit?.operations;
    if (!Array.isArray(operations)) return;
    for (const op of operations) {
      const detail = op?.op === "patch"
        ? ` paths=${
          JSON.stringify(
            (op.patches ?? []).map((p: { path?: string }) => p?.path),
          )
        }`
        : op?.op === "set"
        ? ` keys=${JSON.stringify(Object.keys(op.value?.value ?? {}))}`
        : "";
      console.error(
        `[memwrite conn=${connectionTag}] op=${op?.op} id=${
          String(op?.id).slice(0, 24)
        } scope=${op?.scope ?? "(space)"}${detail}`,
      );
    }
  } catch {
    // Logging only.
  }
}

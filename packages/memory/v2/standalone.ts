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

import { encodeMemoryBoundary } from "../v2.ts";
import * as MemoryServer from "./server.ts";
import { verifySessionOpenAuthorization } from "./session-open-auth.ts";
import {
  deflateWirePayload,
  inflateWirePayload,
  MEMORY_WS_DEFLATE_MIN_BYTES,
  memoryWsDeflateEnabled,
  selectMemoryWsDeflateProtocol,
  SerialTaskQueue,
} from "./transport-deflate.ts";
import { Identity } from "@commonfabric/identity";

const standaloneTextEncoder = new TextEncoder();

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
  readonly url: URL;

  private constructor(memory: MemoryServer.Server, http: Deno.HttpServer) {
    this.#memory = memory;
    this.#http = http;
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
    const http = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (request) => {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("memory websocket endpoint", { status: 200 });
      }
      // SPIKE: mirror toolshed's deflate subprotocol so in-repo clients that
      // offer it keep working against the standalone harness server. The
      // offer is always selected (refusal fails the connection per RFC 6455);
      // the env switch only gates this server's outbound compression.
      const deflateProtocol = selectMemoryWsDeflateProtocol(
        request.headers.get("sec-websocket-protocol"),
      );
      const { socket, response } = Deno.upgradeWebSocket(
        request,
        deflateProtocol !== undefined ? { protocol: deflateProtocol } : {},
      );
      socket.binaryType = "arraybuffer";
      const connectionTag = nextConnectionTag++;
      const sendQueue =
        deflateProtocol !== undefined && memoryWsDeflateEnabled()
          ? new SerialTaskQueue()
          : null;
      const connection = memory.connect((message) => {
        const payload = encodeMemoryBoundary(message);
        if (sendQueue === null) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
          }
          return;
        }
        void sendQueue.enqueue(async () => {
          if (
            standaloneTextEncoder.encode(payload).byteLength <
              MEMORY_WS_DEFLATE_MIN_BYTES
          ) {
            if (socket.readyState === WebSocket.OPEN) socket.send(payload);
            return;
          }
          const compressed = await deflateWirePayload(payload);
          if (socket.readyState === WebSocket.OPEN) socket.send(compressed);
        }).catch(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "memory websocket send failure");
          }
          connection.close();
        });
      });
      const debugWrites = Deno.env.get("CF_DEBUG_MEMORY_WRITES") === "1";
      const receiveQueue = deflateProtocol !== undefined
        ? new SerialTaskQueue()
        : null;
      const handleText = (text: string) => {
        if (debugWrites) {
          logCommitOperations(connectionTag, text);
        }
        connection.receive(text).catch(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "memory websocket receive failure");
          }
          connection.close();
        });
      };
      socket.addEventListener("message", (event) => {
        const data: unknown = event.data;
        if (typeof data === "string") {
          if (receiveQueue === null) {
            handleText(data);
            return;
          }
          void receiveQueue.enqueue(() => handleText(data)).catch(() => {});
          return;
        }
        if (
          receiveQueue !== null &&
          (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
        ) {
          void receiveQueue.enqueue(async () => {
            handleText(await inflateWirePayload(data));
          }).catch(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.close(1007, "memory websocket inflate failure");
            }
            connection.close();
          });
          return;
        }
        socket.close(1003, "memory websocket expects text frames");
        connection.close();
      });
      const closeAfterPendingFrames = () => {
        if (receiveQueue === null) {
          connection.close();
          return;
        }
        // Frames that arrived before the close still deliver first.
        void receiveQueue.enqueue(() => connection.close()).catch(() => {});
      };
      socket.addEventListener("close", closeAfterPendingFrames);
      socket.addEventListener("error", closeAfterPendingFrames);
      return response;
    });
    return new StandaloneMemoryServer(memory, http);
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

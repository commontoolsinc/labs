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
import { Identity } from "@commonfabric/identity";

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
      const { socket, response } = Deno.upgradeWebSocket(request);
      const connectionTag = nextConnectionTag++;
      const connection = memory.connect((message) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(encodeMemoryBoundary(message));
        }
      });
      const debugWrites = Deno.env.get("CF_DEBUG_MEMORY_WRITES") === "1";
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          socket.close(1003, "memory websocket expects text frames");
          connection.close();
          return;
        }
        if (debugWrites) {
          logCommitOperations(connectionTag, event.data);
        }
        connection.receive(event.data).catch(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "memory websocket receive failure");
          }
          connection.close();
        });
      });
      socket.addEventListener("close", () => connection.close());
      socket.addEventListener("error", () => connection.close());
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
    const parsed = MemoryServer.parseClientMessage(payload);
    const commit = parsed && "commit" in parsed && isRecord(parsed.commit)
      ? parsed.commit
      : undefined;
    const operations = Array.isArray(commit?.operations)
      ? commit.operations
      : undefined;
    if (!Array.isArray(operations)) return;
    for (const op of operations) {
      if (!isRecord(op)) continue;
      const detail = op.op === "patch"
        ? ` paths=${
          JSON.stringify(
            (op.patches ?? []).map((p: { path?: string }) => p?.path),
          )
        }`
        : op.op === "set"
        ? ` keys=${JSON.stringify(Object.keys(op.value?.value ?? {}))}`
        : "";
      const id = "id" in op ? String(op.id).slice(0, 24) : "undefined";
      const scope = "scope" in op ? op.scope ?? "(space)" : "(space)";
      console.error(
        `[memwrite conn=${connectionTag}] op=${op.op} id=${id} scope=${scope}${detail}`,
      );
    }
  } catch {
    // Logging only.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

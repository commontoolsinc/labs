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

import { encodeMemoryBoundary, MEMORY_PROTOCOL } from "../v2.ts";
import * as MemoryServer from "./server.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { fromDID } from "../util.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const sameSessionDescriptor = (
  left: Record<string, unknown>,
  right: { sessionId?: string; seenSeq?: number },
): boolean =>
  (typeof left.sessionId === "string" ? left.sessionId : undefined) ===
    right.sessionId &&
  (typeof left.seenSeq === "number" ? left.seenSeq : undefined) ===
    right.seenSeq;

// Same verification as toolshed's memory route: the session principal is the
// verified issuer of the signed session.open invocation. User/session scoped
// storage partitioning keys off this principal, so clients exercise real
// authentication, not a trusted-client shortcut.
const authorizeSessionOpen = async (
  message: {
    space: string;
    session: { sessionId?: string; seenSeq?: number };
    invocation?: Record<string, unknown>;
    authorization?: unknown;
  },
): Promise<string> => {
  const rawSignature = isRecord(message.authorization)
    ? message.authorization.signature
    : undefined;
  const signature = rawSignature instanceof FabricBytes
    ? rawSignature.slice()
    : null;
  if (!isRecord(message.invocation) || signature === null) {
    throw authorizationError("memory session.open requires authorization");
  }

  const invocation = message.invocation;
  if (
    typeof invocation.iss !== "string" ||
    invocation.cmd !== "session.open" ||
    invocation.sub !== message.space ||
    !isRecord(invocation.args) ||
    invocation.args.protocol !== MEMORY_PROTOCOL ||
    !isRecord(invocation.args.session) ||
    !sameSessionDescriptor(invocation.args.session, message.session)
  ) {
    throw authorizationError("memory session.open authorization mismatch");
  }

  const issuer = await fromDID(invocation.iss);
  if (issuer.error) {
    throw issuer.error;
  }

  const verified = await issuer.ok.verify({
    payload: hashOf(invocation).bytes,
    signature,
  });
  if (verified.error) {
    throw verified.error;
  }

  return invocation.iss;
};

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

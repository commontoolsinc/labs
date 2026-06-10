/**
 * Standalone in-memory storage server for multi-runtime tests.
 *
 * Serves the same memory v2 websocket protocol (and session.open signature
 * verification) as toolshed's `/api/storage/memory` route, but in-process on
 * an ephemeral port with a non-persistent store. This lets several runtimes —
 * including ones in Deno Workers — share one storage backend without a
 * toolshed process.
 */

import { encodeMemoryBoundary, MEMORY_PROTOCOL } from "@commonfabric/memory/v2";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { VerifierIdentity } from "@commonfabric/identity";

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
// storage partitioning keys off this principal, so the tests exercise real
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

  const issuer = await VerifierIdentity.fromDid(
    invocation.iss as `did:key:${string}`,
  );
  const verified = await issuer.verify({
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

  static start(): StandaloneMemoryServer {
    const memory = new MemoryServer.Server({ authorizeSessionOpen });
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
          try {
            const parsed = MemoryServer.parseClientMessage(
              event.data,
            ) as unknown as {
              commit?: { operations?: unknown[] };
            };
            const operations = parsed?.commit?.operations as
              | Array<Record<string, any>>
              | undefined;
            if (Array.isArray(operations)) {
              for (const op of operations) {
                const detail = op?.op === "patch"
                  ? ` paths=${
                    JSON.stringify(
                      (op.patches ?? []).map((p: { path?: string }) => p?.path),
                    )
                  }`
                  : op?.op === "set"
                  ? ` keys=${
                    JSON.stringify(Object.keys(op.value?.value ?? {}))
                  }`
                  : "";
                console.error(
                  `[memwrite conn=${connectionTag}] op=${op?.op} id=${
                    String(op?.id).slice(0, 24)
                  } scope=${op?.scope ?? "(space)"}${detail}`,
                );
              }
            }
          } catch {
            // Best-effort logging only.
          }
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

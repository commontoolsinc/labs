/**
 * Real-socket coverage for the standalone harness server's non-transport
 * behavior: the plain-HTTP response for non-websocket requests, and the
 * CF_DEBUG_MEMORY_WRITES commit tracing — one stderr line per operation with
 * op/id/scope — including that tracing never interferes with message
 * handling, even for frames the server cannot parse.
 */
import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type SessionOpenChallenge,
} from "../v2.ts";
import { StandaloneMemoryServer } from "../v2/standalone.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type HelloOk = {
  type: "hello.ok";
  sessionOpen: { audience: string; challenge: SessionOpenChallenge };
};

const openSocket = async (url: URL): Promise<WebSocket> => {
  const address = new URL(url);
  address.protocol = "ws:";
  const socket = new WebSocket(address);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
  return socket;
};

const readWireMessage = async <Message extends FabricValue>(
  socket: WebSocket,
): Promise<Message> => {
  const data = await new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        resolve(event.data);
        return;
      }
      reject(new Error("Unexpected binary websocket frame"));
    }, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket error before message")),
      { once: true },
    );
  });
  return decodeMemoryBoundary<Message>(data);
};

const closeSocket = async (socket: WebSocket): Promise<void> => {
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });
  socket.close();
  await closed;
};

const openSession = async (
  socket: WebSocket,
  identity: Identity,
): Promise<string> => {
  socket.send(encodeMemoryBoundary(HELLO));
  const hello = await readWireMessage<HelloOk>(socket);
  assertEquals(hello.type, "hello.ok");

  const space = identity.did();
  const iat = Math.floor(Date.now() / 1000);
  const invocation = {
    iss: identity.did(),
    cmd: "session.open",
    sub: space,
    aud: hello.sessionOpen.audience,
    args: { protocol: MEMORY_PROTOCOL, session: {} },
    challenge: hello.sessionOpen.challenge.value,
    iat,
    exp: iat + 300,
  };
  const signature = await identity.sign(hashOf(invocation).bytes);
  if (signature.error) throw signature.error;
  socket.send(encodeMemoryBoundary({
    type: "session.open",
    requestId: "open-1",
    space,
    session: {},
    invocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  }));
  const opened = await readWireMessage<{
    type: "response";
    ok: { sessionId: string };
  }>(socket);
  assertEquals(opened.type, "response");
  return opened.ok.sessionId;
};

describe("standalone memory server", () => {
  it("answers non-websocket requests with a plain identification page", async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const response = await fetch(server.url);
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "memory websocket endpoint");
    } finally {
      await server.close();
    }
  });

  it("traces one line per commit operation under CF_DEBUG_MEMORY_WRITES", async () => {
    const previousEnv = Deno.env.get("CF_DEBUG_MEMORY_WRITES");
    const originalError = console.error;
    const stderrLines: string[] = [];
    Deno.env.set("CF_DEBUG_MEMORY_WRITES", "1");
    console.error = (...args: unknown[]) => {
      stderrLines.push(args.map(String).join(" "));
    };

    const identity = await Identity.fromPassphrase("standalone-tracing");
    const server = StandaloneMemoryServer.start();
    try {
      const socket = await openSocket(server.url);
      const space = identity.did();
      const sessionId = await openSession(socket, identity);

      socket.send(encodeMemoryBoundary({
        type: "transact",
        requestId: "tx-set",
        space,
        sessionId,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:trace",
            value: { value: { fat: "initial" } },
          }],
        },
      }));
      const setResponse = await readWireMessage<{
        type: "response";
        error?: { name: string };
      }>(socket);
      assertEquals(setResponse.error, undefined);

      socket.send(encodeMemoryBoundary({
        type: "transact",
        requestId: "tx-patch",
        space,
        sessionId,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "of:doc:trace",
            patches: [{ op: "replace", path: "/value/fat", value: "patched" }],
          }],
        },
      }));
      const patchResponse = await readWireMessage<{
        type: "response";
        error?: { name: string };
      }>(socket);
      assertEquals(patchResponse.error, undefined);

      // Tracing inspects every inbound text frame before the server parses
      // it, so an unparseable frame must still get the server's normal
      // invalid-message response — tracing never breaks handling.
      socket.send("this is not a memory frame");
      const invalid = await readWireMessage<{
        type: "response";
        requestId: string;
        error?: { name: string };
      }>(socket);
      assertEquals(invalid.requestId, "invalid");
      assertEquals(invalid.error?.name, "InvalidMessageError");

      await closeSocket(socket);
    } finally {
      await server.close();
      console.error = originalError;
      if (previousEnv === undefined) {
        Deno.env.delete("CF_DEBUG_MEMORY_WRITES");
      } else {
        Deno.env.set("CF_DEBUG_MEMORY_WRITES", previousEnv);
      }
    }

    const traces = stderrLines.filter((line) => line.includes("[memwrite"));
    assertEquals(traces.length, 2, traces.join("\n"));
    assertStringIncludes(traces[0], "op=set");
    assertStringIncludes(traces[0], "id=of:doc:trace");
    assertStringIncludes(traces[0], 'keys=["fat"]');
    assertStringIncludes(traces[0], "scope=(space)");
    assertStringIncludes(traces[1], "op=patch");
    assertStringIncludes(traces[1], 'paths=["/value/fat"]');
  });
});

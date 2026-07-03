import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
} from "../v2.ts";
import { StandaloneMemoryServer } from "../v2/standalone.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const openSocket = async (url: URL): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
  return socket;
};

const waitFor = async (
  predicate: () => boolean,
  timeout = 5000,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

Deno.test("standalone memory server traces debug writes", async () => {
  const previousDebug = Deno.env.get("CF_DEBUG_MEMORY_WRITES");
  const previousError = console.error;
  const errors: string[] = [];
  let server: StandaloneMemoryServer | undefined;
  let socket: WebSocket | undefined;

  try {
    Deno.env.set("CF_DEBUG_MEMORY_WRITES", "1");
    console.error = (...args: unknown[]) =>
      errors.push(args.map(String).join(" "));

    server = StandaloneMemoryServer.start();
    const socketUrl = new URL(server.url);
    socketUrl.protocol = "ws:";
    socket = await openSocket(socketUrl);

    socket.send(encodeMemoryBoundary(HELLO));
    socket.send(encodeMemoryBoundary({
      type: "transact",
      requestId: "debug-missing-ops",
      space: "did:key:z6Mk-standalone-debug",
      sessionId: "session:debug",
      commit: {},
    }));
    socket.send(encodeMemoryBoundary({
      type: "transact",
      requestId: "debug-tx",
      space: "did:key:z6Mk-standalone-debug",
      sessionId: "session:debug",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:doc:set",
            value: { value: { alpha: 1, beta: 2 } },
          },
          {
            op: "patch",
            id: "of:doc:patch",
            scope: "user",
            patches: [
              { op: "replace", path: "/value/title", value: "hello" },
            ],
          },
          null,
        ],
      },
    }));

    await waitFor(() => errors.length === 3);
    assertStringIncludes(errors[0], "op=set");
    assertStringIncludes(errors[0], 'keys=["alpha","beta"]');
    assertStringIncludes(errors[1], "op=patch");
    assertStringIncludes(errors[1], 'paths=["/value/title"]');
    assertStringIncludes(errors[1], "scope=user");
    assertStringIncludes(errors[2], "op=undefined");
    assertStringIncludes(errors[2], "id=undefined");
    assertEquals(
      errors.every((error) => error.includes("[memwrite conn=")),
      true,
    );

    let throwCalls = 0;
    console.error = () => {
      throwCalls++;
      throw new Error("debug trace sink failed");
    };
    socket.send(encodeMemoryBoundary({
      type: "transact",
      requestId: "debug-catch",
      space: "did:key:z6Mk-standalone-debug",
      sessionId: "session:debug",
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:doc:catch",
            value: { value: { gamma: 3 } },
          },
        ],
      },
    }));
    await waitFor(() => throwCalls === 1);
  } finally {
    try {
      socket?.close();
      await server?.close();
    } finally {
      console.error = previousError;
      if (previousDebug === undefined) {
        Deno.env.delete("CF_DEBUG_MEMORY_WRITES");
      } else {
        Deno.env.set("CF_DEBUG_MEMORY_WRITES", previousDebug);
      }
    }
  }
});

import { assert, assertEquals } from "@std/assert";
import app from "../../../app.ts";
import { MEMORY_V2_PROTOCOL } from "@commontools/memory/v2";
import { Identity } from "@commontools/identity";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const openSocket = async (url: URL): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", (event) => reject(event), { once: true });
  });
  return socket;
};

const readJsonMessage = async <Message>(socket: WebSocket): Promise<Message> => {
  const payload = await new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        reject(new Error("Expected a string websocket message"));
        return;
      }
      resolve(event.data);
    }, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("WebSocket error before message")),
      { once: true },
    );
  });

  return JSON.parse(payload) as Message;
};

Deno.test("memory websocket supports a runtime using the v2 cutover path", async () => {
  const identity = await Identity.fromPassphrase("memory-v2-route-traffic");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `http://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const storageManager = StorageManager.open({
      as: identity,
      address,
      memoryVersion: "v2",
    });
    const runtime = new Runtime({
      apiUrl: new URL(`http://${server.addr.hostname}:${server.addr.port}`),
      storageManager,
      memoryVersion: "v2",
    });
    const tx = runtime.edit();
    const cell = runtime.getCell(
      identity.did(),
      `memory-v2-toolshed-${Date.now()}`,
      undefined,
      tx,
    );

    cell.set({ hello: "world" });
    await tx.commit();
    await runtime.idle();

    const persisted = storageManager.open(identity.did()).get(
      cell.getAsNormalizedFullLink().id,
    );

    assertEquals(persisted?.value, { hello: "world" });

    await runtime.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket persists v2 runtime data across fresh runtimes", async () => {
  const identity = await Identity.fromPassphrase("memory-v2-route-persist");
  const server = Deno.serve({ port: 0 }, app.fetch);
  const base = new URL(`http://${server.addr.hostname}:${server.addr.port}`);
  const address = new URL("/api/storage/memory", base);
  const cause = `memory-v2-toolshed-persist-${Date.now()}`;

  try {
    const runtime1 = new Runtime({
      apiUrl: base,
      storageManager: StorageManager.open({
        as: identity,
        address,
        memoryVersion: "v2",
      }),
      memoryVersion: "v2",
    });
    const tx = runtime1.edit();
    const writer = runtime1.getCell(identity.did(), cause, undefined, tx);
    writer.set({ persisted: true, count: 1 });
    await tx.commit();
    await runtime1.idle();
    await runtime1.dispose();

    const runtime2 = new Runtime({
      apiUrl: base,
      storageManager: StorageManager.open({
        as: identity,
        address,
        memoryVersion: "v2",
      }),
      memoryVersion: "v2",
    });
    const reader = runtime2.getCell(identity.did(), cause);
    await reader.sync();
    await runtime2.storageManager.synced();

    assertEquals(reader.get(), { persisted: true, count: 1 });

    await runtime2.dispose();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket negotiates a v2 session", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    socket.send(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));

    const message = await readJsonMessage<{
      type: "hello.ok";
      protocol: string;
    }>(socket);

    assertEquals(message.type, "hello.ok");
    assertEquals(message.protocol, MEMORY_V2_PROTOCOL);

    socket.send(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-toolshed-open",
      session: {},
    }));

    const opened = await readJsonMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);

    assertEquals(opened.type, "response");
    assertEquals(opened.requestId, "open-1");
    assertEquals(opened.ok.serverSeq, 0);
    assert(opened.ok.sessionId.length > 0);

    socket.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket resumes a requested v2 session id", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    socket.send(JSON.stringify({
      type: "hello",
      protocol: MEMORY_V2_PROTOCOL,
    }));

    await readJsonMessage(socket);

    socket.send(JSON.stringify({
      type: "session.open",
      requestId: "open-1",
      space: "did:key:z6Mk-toolshed-resume",
      session: {
        sessionId: "session:test-resume",
        seenSeq: 7,
      },
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      ok: { sessionId: string; serverSeq: number };
    }>(socket);

    assertEquals(message.type, "response");
    assertEquals(message.requestId, "open-1");
    assertEquals(message.ok.sessionId, "session:test-resume");
    assertEquals(message.ok.serverSeq, 0);

    socket.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("memory websocket requires hello before opening a v2 session", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    socket.send(JSON.stringify({
      type: "session.open",
      requestId: "open-without-hello",
      space: "did:key:z6Mk-toolshed-no-hello",
      session: {},
    }));

    const message = await readJsonMessage<{
      type: "response";
      requestId: string;
      error: { name: string; message: string };
    }>(socket);

    assertEquals(message.type, "response");
    assertEquals(message.requestId, "handshake");
    assertEquals(message.error.name, "ProtocolError");

    socket.close();
  } finally {
    await server.shutdown();
  }
});

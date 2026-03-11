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

Deno.test("memory websocket negotiates a v2 session", async () => {
  const server = Deno.serve({ port: 0 }, app.fetch);
  const address = new URL(
    `ws://${server.addr.hostname}:${server.addr.port}/api/storage/memory`,
  );

  try {
    const socket = await openSocket(address);
    socket.send(JSON.stringify({
      cmd: "session.open",
      id: "job:test-open",
      protocol: MEMORY_V2_PROTOCOL,
      args: {},
    }));

    const message = await readJsonMessage<{
      the: "task/return";
      of: string;
      is: { ok: { sessionId: string; serverSeq: number } };
    }>(socket);

    assertEquals(message.the, "task/return");
    assertEquals(message.of, "job:test-open");
    assertEquals(message.is.ok.serverSeq, 0);
    assert(message.is.ok.sessionId.length > 0);

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
      cmd: "session.open",
      id: "job:test-resume",
      protocol: MEMORY_V2_PROTOCOL,
      args: {
        sessionId: "session:test-resume",
        seenSeq: 7,
      },
    }));

    const message = await readJsonMessage<{
      the: "task/return";
      of: string;
      is: { ok: { sessionId: string; serverSeq: number } };
    }>(socket);

    assertEquals(message.the, "task/return");
    assertEquals(message.of, "job:test-resume");
    assertEquals(message.is.ok.sessionId, "session:test-resume");
    assertEquals(message.is.ok.serverSeq, 0);

    socket.close();
  } finally {
    await server.shutdown();
  }
});

import { assertEquals, assertRejects } from "@std/assert";
import { InspectorProtocolClient } from "./inspector-protocol-client.ts";

class FakeInspectorSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  receive(message: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

Deno.test("InspectorProtocolClient sends commands and resolves responses", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const stop = client.Profiler.stop();
  assertEquals(JSON.parse(socket.sent[0]), {
    id: 1,
    method: "Profiler.stop",
    params: {},
  });

  const profile = { nodes: [{ id: 1 }] };
  socket.receive({ id: 1, result: { profile } });
  assertEquals(await stop, { profile });
});

Deno.test("InspectorProtocolClient exposes the profiling command set", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const commands = [
    client.Runtime.enable(),
    client.Console.enable(),
    client.Debugger.enable({}),
    client.Profiler.enable(),
    client.Profiler.setSamplingInterval({ interval: 100 }),
    client.Profiler.start(),
  ];
  assertEquals(socket.sent.map((message) => JSON.parse(message)), [
    { id: 1, method: "Runtime.enable", params: {} },
    { id: 2, method: "Console.enable", params: {} },
    { id: 3, method: "Debugger.enable", params: {} },
    { id: 4, method: "Profiler.enable", params: {} },
    {
      id: 5,
      method: "Profiler.setSamplingInterval",
      params: { interval: 100 },
    },
    { id: 6, method: "Profiler.start", params: {} },
  ]);

  for (let id = 1; id <= commands.length; id++) {
    socket.receive({ id, result: {} });
  }
  await Promise.all(commands);
});

Deno.test("InspectorProtocolClient forwards protocol events", () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());
  const received: unknown[] = [];
  client.addEventListener("Runtime.consoleAPICalled", (event) => {
    received.push((event as CustomEvent).detail);
  });

  const detail = { type: "log", args: [{ type: "string", value: "hello" }] };
  socket.receive({
    method: "Runtime.consoleAPICalled",
    params: detail,
  });

  assertEquals(received, [detail]);
});

Deno.test("InspectorProtocolClient rejects protocol errors", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const enable = client.Runtime.enable();
  socket.receive({
    id: 1,
    error: {
      code: -32601,
      message: "Method not found",
      data: "Runtime.enable",
    },
  });

  await assertRejects(
    () => enable,
    Error,
    "Method not found (-32601): Runtime.enable",
  );
});

Deno.test("InspectorProtocolClient rejects commands when the socket closes", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const enable = client.Console.enable();
  socket.close();

  await assertRejects(
    () => enable,
    Error,
    "Inspector WebSocket closed",
  );
});

Deno.test("InspectorProtocolClient rejects commands when an earlier close listener closes the client", async () => {
  const socket = new FakeInspectorSocket();
  let closeFromListener: Promise<void> | undefined;
  socket.addEventListener("close", () => {
    closeFromListener = client.close();
  });
  const client = new InspectorProtocolClient(socket.asWebSocket());

  const enable = client.Console.enable();
  const rejected = assertRejects(
    () => enable,
    Error,
    "Inspector WebSocket closed",
  );
  socket.close();

  await closeFromListener;
  await rejected;
});

Deno.test("InspectorProtocolClient closes its WebSocket", async () => {
  const socket = new FakeInspectorSocket();
  const client = new InspectorProtocolClient(socket.asWebSocket());

  await client.close();

  assertEquals(socket.readyState, WebSocket.CLOSED);
});

import { assertEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import { MEMORY_V2_PROTOCOL } from "../v2.ts";
import { connect, loopback, type Transport } from "../v2/client.ts";

Deno.test("memory v2 client transacts and receives graph subscription updates", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client"),
  });
  const client = await connect({
    transport: loopback(server),
  });
  const space = await client.mount("did:key:z6Mk-memory-v2-client");

  const view = await space.queryGraph({
    subscribe: true,
    roots: [{
      id: "of:doc:1",
      selector: {
        path: [],
        schema: false,
      },
    }],
  });

  assertEquals(
    view.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 0,
      document: null,
    }],
  );

  const updates = view.subscribe();
  const pending = updates.next();

  const commit = await space.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:doc:1",
      value: {
        value: {
          hello: "client",
        },
      },
    }],
  });

  assertEquals(commit.seq, 1);

  const update = await pending;
  assertEquals(update.done, false);
  assertEquals(
    update.value.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 1,
      document: {
        value: {
          hello: "client",
        },
      },
    }],
  );

  await client.close();
  await server.close();
});

class ReconnectableLoopbackTransport implements Transport {
  connectionCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;

  constructor(private readonly server: Server) {}

  async send(payload: string): Promise<void> {
    await this.connection().receive(payload);
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("disconnect"));
  }

  private connection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.connectionCount++;
      this.#connection = this.server.connect((message) => {
        this.#receiver(JSON.stringify(message));
      });
    }
    return this.#connection;
  }
}

class ScriptedReconnectTransport implements Transport {
  connectionCount = 0;
  transactLocalSeqs: number[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connected = false;
  #dropped = new Set<number>();

  constructor(private readonly dropOnFirstLocalSeqs: number[] = []) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    if (!this.#connected) {
      this.#connected = true;
      this.connectionCount++;
    }

    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
      commit?: { localSeq?: number };
    };

    switch (message.type) {
      case "hello":
        this.#respond({
          type: "hello.ok",
          protocol: MEMORY_V2_PROTOCOL,
        });
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:scripted",
            serverSeq: 0,
          },
        });
        return Promise.resolve();
      case "transact": {
        const localSeq = message.commit?.localSeq ?? -1;
        this.transactLocalSeqs.push(localSeq);
        if (
          this.dropOnFirstLocalSeqs.includes(localSeq) &&
          !this.#dropped.has(localSeq)
        ) {
          this.#dropped.add(localSeq);
          this.#connected = false;
          this.#closeReceiver(new Error("disconnect"));
          return Promise.resolve();
        }

        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            seq: localSeq,
            hash: `commit:${localSeq}`,
            branch: "",
            facts: [{
              hash: `fact:${localSeq}:0`,
              id: `of:doc:${localSeq}`,
              valueRef: `value:${localSeq}:0`,
              parent: null,
              branch: "",
              seq: localSeq,
              commitSeq: localSeq,
              factType: "set",
            }],
          },
        });
        return Promise.resolve();
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
  }
}

class CloseOnSessionOpenTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connected = false;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    if (!this.#connected) {
      this.#connected = true;
    }

    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
    };

    if (message.type === "hello") {
      this.#receiver(JSON.stringify({
        type: "hello.ok",
        protocol: MEMORY_V2_PROTOCOL,
      }));
      return Promise.resolve();
    }

    if (message.type === "session.open") {
      this.#closeReceiver(
        new DOMException("memory/v2 transport closed", "NetworkError") as Error,
      );
      return Promise.resolve();
    }

    throw new Error(`Unhandled close-on-open message: ${message.type}`);
  }

  close(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeout = 500,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

Deno.test("memory v2 client reconnects and reissues graph subscriptions", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-reconnect"),
  });
  const transport = new ReconnectableLoopbackTransport(server);
  const client = await connect({ transport });
  const writerClient = await connect({
    transport: loopback(server),
  });
  const space = await client.mount("did:key:z6Mk-memory-v2-client-reconnect");
  const writer = await writerClient.mount(
    "did:key:z6Mk-memory-v2-client-reconnect",
  );
  const originalSessionId = space.sessionId;

  const view = await space.queryGraph({
    subscribe: true,
    roots: [{
      id: "of:doc:1",
      selector: {
        path: [],
        schema: false,
      },
    }],
  });
  const updates = view.subscribe();

  transport.disconnect();
  await waitFor(() => transport.connectionCount >= 2);

  const pending = updates.next();
  await writer.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:doc:1",
      value: {
        value: {
          hello: "reconnected",
        },
      },
    }],
  });

  const update = await pending;
  assertEquals(update.done, false);
  assertEquals(space.sessionId, originalSessionId);
  assertEquals(
    update.value.entities.map((entity: any) => ({
      id: entity.id,
      seq: entity.seq,
      document: entity.document,
    })),
    [{
      id: "of:doc:1",
      seq: 1,
      document: {
        value: {
          hello: "reconnected",
        },
      },
    }],
  );

  await writerClient.close();
  await client.close();
  await server.close();
});

Deno.test("memory v2 client replays an in-flight transact after reconnect", async () => {
  const transport = new ScriptedReconnectTransport([1]);
  const client = await connect({ transport });
  const space = await client.mount("did:key:z6Mk-memory-v2-client-replay");

  try {
    const applied = await space.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            hello: "replayed",
          },
        },
      }],
    });

    assertEquals(transport.connectionCount, 2);
    assertEquals(transport.transactLocalSeqs, [1, 1]);
    assertEquals(applied.seq, 1);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client replays retained commits in localSeq order after reconnect", async () => {
  const transport = new ScriptedReconnectTransport([1]);
  const client = await connect({ transport });
  const space = await client.mount(
    "did:key:z6Mk-memory-v2-client-replay-order",
  );

  try {
    const first = space.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            count: 1,
          },
        },
      }],
    });
    const second = space.transact({
      localSeq: 2,
      reads: {
        confirmed: [],
        pending: [{
          id: "of:doc:1",
          path: ["value"],
          localSeq: 1,
        }],
      },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            count: 2,
          },
        },
      }],
    });

    const [applied1, applied2] = await Promise.all([first, second]);

    assertEquals(transport.connectionCount, 2);
    assertEquals(transport.transactLocalSeqs, [1, 1, 2]);
    assertEquals(applied1.seq, 1);
    assertEquals(applied2.seq, 2);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client wraps close errors with read-only names", async () => {
  const client = await connect({
    transport: new CloseOnSessionOpenTransport(),
  });

  try {
    await client.mount("did:key:z6Mk-memory-v2-close-error");
  } catch (error) {
    assertEquals(error instanceof Error, true);
    assertEquals((error as Error).name, "ConnectionError");
    assertEquals((error as Error).message, "memory/v2 transport closed");
    await client.close();
    return;
  }

  await client.close();
  throw new Error("Expected mount() to fail");
});

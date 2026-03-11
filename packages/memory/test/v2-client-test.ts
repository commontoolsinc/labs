import { assertEquals } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  connect,
  loopback,
  type Transport,
} from "../v2/client.ts";

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

  assertEquals(view.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 0,
    document: null,
  }]);

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
  assertEquals(update.value.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 1,
    document: {
      value: {
        hello: "client",
      },
    },
  }]);

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

  async close(): Promise<void> {
    this.disconnect();
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

class SabotagedLoopbackTransport implements Transport {
  connectionCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #dropResponses = false;
  #dropNextResponsePredicate: ((payload: string) => boolean) | null = null;

  constructor(private readonly server: Server) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(payload: string): Promise<void> {
    const shouldDrop = this.#dropNextResponsePredicate?.(payload) ?? false;
    if (shouldDrop) {
      this.#dropNextResponsePredicate = null;
      this.#dropResponses = true;
      try {
        await this.connection().receive(payload);
      } finally {
        this.#dropResponses = false;
        this.disconnect();
      }
      return;
    }

    await this.connection().receive(payload);
  }

  async close(): Promise<void> {
    this.disconnect();
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("disconnect"));
  }

  dropNextResponse(predicate: (payload: string) => boolean): void {
    this.#dropNextResponsePredicate = predicate;
  }

  private connection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.connectionCount++;
      this.#connection = this.server.connect((message) => {
        if (!this.#dropResponses) {
          this.#receiver(JSON.stringify(message));
        }
      });
    }
    return this.#connection;
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
  const writer = await writerClient.mount("did:key:z6Mk-memory-v2-client-reconnect");
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
  assertEquals(update.value.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 1,
    document: {
      value: {
        hello: "reconnected",
      },
    },
  }]);

  await writerClient.close();
  await client.close();
  await server.close();
});

Deno.test("memory v2 client replays an in-flight transact after reconnect", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-replay"),
  });
  const transport = new SabotagedLoopbackTransport(server);
  const client = await connect({ transport });
  const readerClient = await connect({
    transport: loopback(server),
  });
  const spaceId = "did:key:z6Mk-memory-v2-client-replay";
  const space = await client.mount(spaceId);
  const reader = await readerClient.mount(spaceId);

  transport.dropNextResponse((payload) => {
    const message = JSON.parse(payload) as { type?: string; commit?: { localSeq?: number } };
    return message.type === "transact" && message.commit?.localSeq === 1;
  });

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

  const view = await reader.queryGraph({
    roots: [{
      id: "of:doc:1",
      selector: {
        path: [],
        schema: false,
      },
    }],
  });

  assertEquals(transport.connectionCount >= 2, true);
  assertEquals(applied.seq, 1);
  assertEquals(view.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 1,
    document: {
      value: {
        hello: "replayed",
      },
    },
  }]);

  await readerClient.close();
  await client.close();
  await server.close();
});

Deno.test("memory v2 client replays retained commits in localSeq order after reconnect", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-replay-order"),
  });
  const transport = new SabotagedLoopbackTransport(server);
  const client = await connect({ transport });
  const readerClient = await connect({
    transport: loopback(server),
  });
  const spaceId = "did:key:z6Mk-memory-v2-client-replay-order";
  const space = await client.mount(spaceId);
  const reader = await readerClient.mount(spaceId);

  transport.dropNextResponse((payload) => {
    const message = JSON.parse(payload) as { type?: string; commit?: { localSeq?: number } };
    return message.type === "transact" && message.commit?.localSeq === 1;
  });

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
  const view = await reader.queryGraph({
    roots: [{
      id: "of:doc:1",
      selector: {
        path: [],
        schema: false,
      },
    }],
  });

  assertEquals(transport.connectionCount >= 2, true);
  assertEquals(applied1.seq, 1);
  assertEquals(applied2.seq, 2);
  assertEquals(view.entities.map((entity: any) => ({
    id: entity.id,
    seq: entity.seq,
    document: entity.document,
  })), [{
    id: "of:doc:1",
    seq: 2,
    document: {
      value: {
        count: 2,
      },
    },
  }]);

  await readerClient.close();
  await client.close();
  await server.close();
});

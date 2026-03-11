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

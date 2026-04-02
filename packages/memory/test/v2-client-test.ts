import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { Server, SessionRegistry } from "../v2/server.ts";
import {
  type EntitySnapshot,
  getMemoryV2Flags,
  MEMORY_V2_PROTOCOL,
  type SessionSync,
  toDocumentPath,
} from "../v2.ts";
import { connect, loopback, type Transport, WatchView } from "../v2/client.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const HELLO_OK = {
  type: "hello.ok",
  protocol: MEMORY_V2_PROTOCOL,
  flags: getMemoryV2Flags(),
} as const;

Deno.test("memory v2 client watch sets expand to previously hidden graph nodes", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-graph-expansion"),
  });
  const writerClient = await connect({
    transport: loopback(server),
  });
  const observerClient = await connect({
    transport: loopback(server),
  });
  const writer = await writerClient.mount(
    "did:key:z6Mk-memory-v2-client-graph",
  );
  const observer = await observerClient.mount(
    "did:key:z6Mk-memory-v2-client-graph",
  );
  const fixture = createGraphFixture(writer.space);

  try {
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: fixture.docs.map((doc) => ({
        op: "set" as const,
        id: doc.id,
        value: { value: doc.value } as const,
      })),
    });

    const view = await observer.watchSet([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: fixture.rootId,
          selector: {
            path: [],
            schema: fixture.schema,
          },
        }],
      },
    }]);

    assertEquals(
      view.entities.map((entity) => entity.id),
      fixture.initialReachableIds,
    );

    const updates = view.subscribe();
    const pending = updates.next();
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: fixture.rootId,
        value: { value: fixture.expandedRootValue } as const,
      }],
    });

    const update = await pending;
    assertEquals(update.done, false);
    assertEquals(
      update.value.entities.map((entity: EntitySnapshot) => entity.id),
      fixture.expandedReachableIds,
    );
  } finally {
    await writerClient.close();
    await observerClient.close();
    await server.close();
  }
});

Deno.test("memory v2 client can bootstrap watches with watchAdd", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-watch-add-bootstrap"),
  });
  const writerClient = await connect({
    transport: loopback(server),
  });
  const observerClient = await connect({
    transport: loopback(server),
  });
  const writer = await writerClient.mount(
    "did:key:z6Mk-memory-v2-client-watch-add-bootstrap",
  );
  const observer = await observerClient.mount(
    "did:key:z6Mk-memory-v2-client-watch-add-bootstrap",
  );

  try {
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            hello: "watch-add",
          },
        },
      }],
    });

    const view = await observer.watchAdd([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }]);

    assertEquals(
      view.entities.map((entity) => ({
        id: entity.id,
        seq: entity.seq,
        document: entity.document,
      })),
      [{
        id: "of:doc:1",
        seq: 1,
        document: {
          value: {
            hello: "watch-add",
          },
        },
      }],
    );
  } finally {
    await writerClient.close();
    await observerClient.close();
    await server.close();
  }
});

Deno.test("memory v2 client watch views expose incremental sync effects", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-watch-sync-effects"),
  });
  const writerClient = await connect({
    transport: loopback(server),
  });
  const observerClient = await connect({
    transport: loopback(server),
  });
  const writer = await writerClient.mount(
    "did:key:z6Mk-memory-v2-client-watch-sync-effects",
  );
  const observer = await observerClient.mount(
    "did:key:z6Mk-memory-v2-client-watch-sync-effects",
  );

  try {
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            version: 1,
          },
        },
      }],
    });

    const view = await observer.watchAdd([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }]);
    const updates = view.subscribeSync();
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: {
          value: {
            version: 2,
          },
        },
      }],
    });

    const next = await updates.next();
    assertEquals(next.done, false);
    assertEquals(next.value as SessionSync, {
      type: "sync",
      fromSeq: 1,
      toSeq: 2,
      upserts: [{
        branch: "",
        id: "of:doc:1",
        seq: 2,
        doc: {
          value: {
            version: 2,
          },
        },
      }],
      removes: [],
    });
  } finally {
    await writerClient.close();
    await observerClient.close();
    await server.close();
  }
});

Deno.test("memory v2 client coalesces watch ack bursts", async () => {
  const transport = new AckCountingTransport();
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-memory-v2-client-ack-burst");

  try {
    await session.watchAdd([{
      id: "root:1",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }]);
    await session.watchAdd([{
      id: "root:2",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:2",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(transport.ackCount, 1);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 watch view keeps emitted snapshots incrementally ordered", async () => {
  const view = WatchView.fromSync({
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:doc:b",
      seq: 1,
      doc: { value: { label: "b" } },
    }, {
      branch: "",
      id: "of:doc:a",
      seq: 1,
      doc: { value: { label: "a" } },
    }],
    removes: [],
  });

  assertEquals(
    view.entities.map((entity) => entity.id),
    ["of:doc:a", "of:doc:b"],
  );

  const syncs = view.subscribeSync();
  const snapshots = view.subscribe();
  view.applySync({
    type: "sync",
    fromSeq: 1,
    toSeq: 2,
    upserts: [{
      branch: "",
      id: "of:doc:c",
      seq: 2,
      doc: { value: { label: "c" } },
    }, {
      branch: "",
      id: "of:doc:a",
      seq: 2,
      doc: { value: { label: "a2" } },
    }],
    removes: [{
      branch: "",
      id: "of:doc:b",
    }],
  }, true);

  const nextSync = await syncs.next();
  assertEquals(nextSync.done, false);
  assertEquals((nextSync.value as SessionSync).toSeq, 2);

  const nextSnapshot = await snapshots.next();
  assertEquals(nextSnapshot.done, false);
  assertEquals(
    nextSnapshot.value.entities.map((entity: EntitySnapshot) => entity.id),
    ["of:doc:a", "of:doc:c"],
  );
  assertEquals(
    view.entities.map((entity) => entity.id),
    ["of:doc:a", "of:doc:c"],
  );
});

Deno.test("memory v2 client close settles a pending ack flush", async () => {
  const time = new FakeTime();
  const transport = new HangingAckTransport();
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-memory-v2-client-close-ack");

  try {
    await session.watchAdd([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:1",
          selector: {
            path: [],
            schema: false,
          },
        }],
      },
    }]);

    await time.tickAsync(0);
    await time.runMicrotasks();

    const closePromise = client.close();
    await time.runMicrotasks();
    await closePromise;

    assertEquals(transport.ackCount, 1);
  } finally {
    time.restore();
  }
});

class ReconnectableLoopbackTransport implements Transport {
  connectionCount = 0;
  watchSetCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;

  constructor(private readonly server: Server) {}

  async send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as { type?: string };
    await this.connection().receive(payload);
    if (message.type === "session.watch.set") {
      this.watchSetCount++;
    }
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
        this.#respond(HELLO_OK);
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
      case "session.ack":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
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
            branch: "",
            revisions: [{
              id: `of:doc:${localSeq}`,
              branch: "",
              seq: localSeq,
              opIndex: 0,
              commitSeq: localSeq,
              op: "set",
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

class DelayedTransactTransport implements Transport {
  transactLocalSeqs: number[] = [];
  #receiver: (payload: string) => void = () => {};
  #heldResponses: Array<() => void> = [];

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(): void {}

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
      commit?: { localSeq?: number };
    };

    switch (message.type) {
      case "hello":
        this.#respond(HELLO_OK);
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:delayed-transact",
            sessionToken: "token:delayed-transact",
            serverSeq: 0,
          },
        });
        return Promise.resolve();
      case "session.ack":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: 0,
          },
        });
        return Promise.resolve();
      case "transact": {
        const localSeq = message.commit?.localSeq ?? -1;
        this.transactLocalSeqs.push(localSeq);
        this.#heldResponses.push(() =>
          this.#respond({
            type: "response",
            requestId: message.requestId!,
            ok: {
              seq: localSeq,
              branch: "",
              revisions: [{
                id: `of:doc:${localSeq}`,
                branch: "",
                seq: localSeq,
                opIndex: 0,
                commitSeq: localSeq,
                op: "set",
              }],
            },
          })
        );
        return Promise.resolve();
      }
      default:
        throw new Error(`Unhandled delayed message: ${message.type}`);
    }
  }

  releaseNext(): void {
    const next = this.#heldResponses.shift();
    next?.();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
  }
}

class AckCountingTransport implements Transport {
  ackCount = 0;
  #watchSeq = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
    };

    switch (message.type) {
      case "hello":
        this.#respond(HELLO_OK);
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:ack-count",
            serverSeq: 0,
          },
        });
        return Promise.resolve();
      case "session.watch.add":
        this.#watchSeq += 1;
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.#watchSeq,
            sync: {
              type: "sync",
              fromSeq: this.#watchSeq - 1,
              toSeq: this.#watchSeq,
              upserts: [],
              removes: [],
            },
          },
        });
        return Promise.resolve();
      case "session.ack":
        this.ackCount += 1;
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.#watchSeq,
          },
        });
        return Promise.resolve();
      default:
        throw new Error(`Unhandled message ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
  }
}

class HangingAckTransport implements Transport {
  ackCount = 0;
  #watchSeq = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
    };

    switch (message.type) {
      case "hello":
        this.#respond(HELLO_OK);
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:hanging-ack",
            serverSeq: 0,
          },
        });
        return Promise.resolve();
      case "session.watch.add":
        this.#watchSeq += 1;
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.#watchSeq,
            sync: {
              type: "sync",
              fromSeq: this.#watchSeq - 1,
              toSeq: this.#watchSeq,
              upserts: [],
              removes: [],
            },
          },
        });
        return Promise.resolve();
      case "session.ack":
        this.ackCount += 1;
        return Promise.resolve();
      default:
        throw new Error(`Unhandled message ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
  }
}

class ControlledReconnectTransport implements Transport {
  helloCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #allowHello = true;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  blockHello(): void {
    this.#allowHello = false;
  }

  allowHello(): void {
    this.#allowHello = true;
  }

  disconnect(): void {
    this.#closeReceiver(new Error("disconnect"));
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
    };

    switch (message.type) {
      case "hello":
        this.helloCount += 1;
        if (!this.#allowHello) {
          queueMicrotask(() => this.#closeReceiver(new Error("offline")));
          return Promise.resolve();
        }
        this.#receiver(JSON.stringify(HELLO_OK));
        return Promise.resolve();
      case "session.open":
        this.#receiver(JSON.stringify({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:controlled",
            serverSeq: 0,
          },
        }));
        return Promise.resolve();
      default:
        throw new Error(
          `Unhandled controlled reconnect message: ${message.type}`,
        );
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class CloseOnSessionOpenTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
    };

    if (message.type === "hello") {
      this.#receiver(JSON.stringify(HELLO_OK));
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
    return Promise.resolve();
  }
}

class CloseOnAppliedCommitTransport implements Transport {
  onCommitApplied?: () => void;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
      commit?: { localSeq?: number };
    };

    switch (message.type) {
      case "hello":
        this.#receiver(JSON.stringify(HELLO_OK));
        return Promise.resolve();
      case "session.open":
        this.#receiver(JSON.stringify({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:close-on-applied-commit",
            serverSeq: 0,
          },
        }));
        return Promise.resolve();
      case "session.ack":
        this.#receiver(JSON.stringify({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: message.commit?.localSeq ?? 0,
          },
        }));
        return Promise.resolve();
      case "transact":
        this.#receiver(JSON.stringify({
          type: "response",
          requestId: message.requestId!,
          ok: {
            seq: message.commit?.localSeq ?? 0,
            branch: "",
            revisions: [],
          },
        }));
        this.onCommitApplied?.();
        return Promise.resolve();
      default:
        throw new Error(`Unhandled close-on-commit message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver(new Error("close"));
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

const nextWithTimeout = async <Value>(
  iterator: AsyncIterator<Value>,
  timeout = 200,
): Promise<IteratorResult<Value>> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<Value>>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Timed out waiting for iterator item")),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
};

Deno.test(
  "memory v2 client reconnects without reinstalling watch sets when the session resumes",
  async () => {
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

    try {
      const view = await space.watchSet([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }]);
      const syncs = view.subscribeSync();
      const snapshots = view.subscribe();

      transport.disconnect();
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: {
            value: {
              hello: "while-offline",
            },
          },
        }],
      });
      await waitFor(() => transport.connectionCount >= 2);
      const resumed = await syncs.next();
      const snapshot = await nextWithTimeout(snapshots);

      assertEquals(resumed.done, false);
      assertEquals(resumed.value.upserts, [{
        branch: "",
        id: "of:doc:1",
        seq: 1,
        doc: {
          value: {
            hello: "while-offline",
          },
        },
      }]);
      assertEquals(resumed.value.removes, []);
      assertEquals(snapshot.done, false);
      assertEquals(
        snapshot.value.entities.map((entity: EntitySnapshot) => ({
          id: entity.id,
          seq: entity.seq,
          document: entity.document,
        })),
        [{
          id: "of:doc:1",
          seq: 1,
          document: {
            value: {
              hello: "while-offline",
            },
          },
        }],
      );
      assertEquals(transport.watchSetCount, 1);
      assertEquals(space.sessionId, originalSessionId);
      assertEquals(
        view.entities.map((entity: EntitySnapshot) => ({
          id: entity.id,
          seq: entity.seq,
          document: entity.document,
        })),
        [{
          id: "of:doc:1",
          seq: 1,
          document: {
            value: {
              hello: "while-offline",
            },
          },
        }],
      );
    } finally {
      await writerClient.close();
      await client.close();
      await server.close();
    }
  },
);

Deno.test(
  "memory v2 client does not restore a closed session after reconnect",
  async () => {
    const server = new Server({
      store: new URL("memory://memory-v2-client-closed-session-reconnect"),
      sessions: new SessionRegistry({ ttlMs: 0 }),
    });
    const transport = new ReconnectableLoopbackTransport(server);
    const client = await connect({ transport });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-client-closed-session-reconnect",
    );

    try {
      await space.watchSet([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }]);
      assertEquals(transport.watchSetCount, 1);

      await space.close();
      transport.disconnect();
      await waitFor(() => transport.connectionCount >= 2);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assertEquals(transport.watchSetCount, 1);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

Deno.test(
  "memory v2 client reinstalls watch sets when reconnect opens a fresh session",
  async () => {
    const server = new Server({
      store: new URL("memory://memory-v2-client-reconnect-expired"),
      sessions: new SessionRegistry({ ttlMs: 0 }),
    });
    const transport = new ReconnectableLoopbackTransport(server);
    const client = await connect({ transport });
    const writerClient = await connect({
      transport: loopback(server),
    });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-client-reconnect-expired",
    );
    const writer = await writerClient.mount(
      "did:key:z6Mk-memory-v2-client-reconnect-expired",
    );

    try {
      const view = await space.watchSet([{
        id: "root",
        kind: "graph",
        query: {
          roots: [{
            id: "of:doc:1",
            selector: {
              path: [],
              schema: false,
            },
          }],
        },
      }]);
      const updates = view.subscribe();

      transport.disconnect();
      await waitFor(() => transport.watchSetCount >= 2);

      const reinstall = await nextWithTimeout(updates);
      assertEquals(reinstall.done, false);
      assertEquals(
        reinstall.value.entities.map((entity: EntitySnapshot) => ({
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

      const pending = updates.next();
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: {
            value: {
              hello: "fresh-session",
            },
          },
        }],
      });

      const update = await pending;
      assertEquals(update.done, false);
      assertEquals(
        update.value.entities.map((entity: EntitySnapshot) => ({
          id: entity.id,
          seq: entity.seq,
          document: entity.document,
        })),
        [{
          id: "of:doc:1",
          seq: 1,
          document: {
            value: {
              hello: "fresh-session",
            },
          },
        }],
      );
    } finally {
      await writerClient.close();
      await client.close();
      await server.close();
    }
  },
);

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
          path: toDocumentPath(["value"]),
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
    assertEquals(transport.transactLocalSeqs, [1, 2, 1, 2]);
    assertEquals(applied1.seq, 1);
    assertEquals(applied2.seq, 2);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client sends later transacts before earlier responses settle", async () => {
  const transport = new DelayedTransactTransport();
  const client = await connect({ transport });
  const space = await client.mount(
    "did:key:z6Mk-memory-v2-client-send-order",
  );
  let first: Promise<{ seq: number }> | undefined;
  let second: Promise<{ seq: number }> | undefined;

  try {
    first = space.transact({
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
    second = space.transact({
      localSeq: 2,
      reads: {
        confirmed: [],
        pending: [{
          id: "of:doc:1",
          path: toDocumentPath(["value"]),
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

    try {
      await waitFor(() => transport.transactLocalSeqs.length === 2);
      assertEquals(transport.transactLocalSeqs, [1, 2]);
    } finally {
      transport.releaseNext();
      transport.releaseNext();
    }

    const [applied1, applied2] = await Promise.all([first, second]);
    assertEquals(applied1.seq, 1);
    assertEquals(applied2.seq, 2);
  } finally {
    transport.releaseNext();
    transport.releaseNext();
    await client.close();
    await Promise.allSettled(
      [first, second].filter((value) => value !== undefined),
    );
  }
});

Deno.test("memory v2 client closes a revoked session after takeover and rejects stale resume tokens", async () => {
  const server = new Server({
    store: new URL("memory://memory-v2-client-session-takeover"),
  });
  const firstClient = await connect({
    transport: loopback(server),
  });
  const secondClient = await connect({
    transport: loopback(server),
  });
  const staleClient = await connect({
    transport: loopback(server),
  });
  const space = "did:key:z6Mk-memory-v2-client-session-takeover";

  try {
    const first = await firstClient.mount(space, {
      sessionId: "session:shared",
    });
    const initialToken = first.sessionToken;
    assertExists(initialToken);

    const second = await secondClient.mount(space, {
      sessionId: first.sessionId,
      sessionToken: initialToken,
    });
    assertEquals(second.sessionId, first.sessionId);
    assertExists(second.sessionToken);
    assertEquals(second.sessionToken === initialToken, false);

    await assertRejects(
      () => first.queryGraph({ roots: [] }),
      Error,
      "session revoked",
    );

    const applied = await second.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:takeover",
        value: {
          value: {
            adopted: true,
          },
        },
      }],
    });
    assertEquals(applied.seq, 1);

    await assertRejects(
      () =>
        staleClient.mount(space, {
          sessionId: first.sessionId,
          sessionToken: initialToken,
        }),
      Error,
      "resume token is no longer valid",
    );
  } finally {
    await firstClient.close();
    await secondClient.close();
    await staleClient.close();
    await server.close();
  }
});

Deno.test("memory v2 client waits before retrying and then reconnects cleanly", async () => {
  const time = new FakeTime();
  const transport = new ControlledReconnectTransport();
  const client = await connect({ transport });
  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    transport.blockHello();
    transport.disconnect();
    await time.runMicrotasks();

    assertEquals(transport.helloCount, 2);

    await time.tickAsync(24);
    assertEquals(transport.helloCount, 2);

    await time.tickAsync(1);
    await time.runMicrotasks();
    assertEquals(transport.helloCount, 3);

    transport.allowHello();
    for (let step = 0; step < 8 && !client.isConnected(); step += 1) {
      await time.tickAsync(25);
      await time.runMicrotasks();
      await time.runMicrotasks();
    }

    assertEquals(client.isConnected(), true);
    assertEquals(transport.helloCount >= 4, true);
  } finally {
    Math.random = originalRandom;
    const closePromise = client.close();
    await time.runMicrotasks();
    await time.tickAsync(25);
    await time.runMicrotasks();
    await closePromise;
    time.restore();
  }
});

Deno.test("memory v2 client close interrupts long reconnect backoff", async () => {
  const time = new FakeTime();
  const transport = new ControlledReconnectTransport();
  const client = await connect({ transport });
  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    transport.blockHello();
    transport.disconnect();
    await time.runMicrotasks();
    assertEquals(transport.helloCount, 2);

    await time.tickAsync(25);
    await time.runMicrotasks();
    assertEquals(transport.helloCount, 3);

    let closed = false;
    const closePromise = client.close().then(() => {
      closed = true;
    });
    await time.runMicrotasks();

    await time.tickAsync(24);
    assertEquals(closed, false);

    await time.tickAsync(1);
    await time.runMicrotasks();
    assertEquals(closed, true);

    await closePromise;
  } finally {
    Math.random = originalRandom;
    time.restore();
  }
});

Deno.test("memory v2 client rejects hello.ok when flags disagree", async () => {
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload): Promise<void> {
      const message = JSON.parse(payload) as { type?: string };
      if (message.type === "hello") {
        receiver(JSON.stringify({
          type: "hello.ok",
          protocol: MEMORY_V2_PROTOCOL,
          flags: {
            richStorableValues: getMemoryV2Flags().richStorableValues,
            unifiedJsonEncoding: getMemoryV2Flags().unifiedJsonEncoding,
            canonicalHashing: !getMemoryV2Flags().canonicalHashing,
            modernSchemaHash: getMemoryV2Flags().modernSchemaHash,
          },
        }));
      }
      return Promise.resolve();
    },
    async close() {},
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };

  await assertRejects(
    () => connect({ transport }),
    Error,
    "memory/v2 flag mismatch",
  );
});

Deno.test("memory v2 client wraps close errors with connection error names", async () => {
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

Deno.test("memory v2 client returns an applied commit even if it closes right after the response", async () => {
  const transport = new CloseOnAppliedCommitTransport();
  const client = await connect({ transport });
  const space = await client.mount("did:key:z6Mk-memory-v2-close-after-commit");
  let closePromise: Promise<void> | null = null;
  transport.onCommitApplied = () => {
    closePromise ??= client.close();
  };

  try {
    const applied = await space.transact({
      localSeq: 7,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:close-after-commit",
        value: {
          value: {
            hello: "world",
          },
        },
      }],
    });

    assertEquals(applied.seq, 7);
    if (closePromise === null) {
      throw new Error("Expected onCommitApplied to close the client");
    }
    await closePromise;
  } finally {
    await (closePromise ?? client.close());
  }
});

class DisconnectableAckTransport implements Transport {
  ackCount = 0;
  #watchSeq = 0;
  #sessionOpenCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connected = true;
  #blockReconnect = false;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  blockReconnect(): void {
    this.#blockReconnect = true;
  }

  disconnect(): void {
    this.#connected = false;
    this.#closeReceiver(new Error("disconnect"));
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
    };

    switch (message.type) {
      case "hello":
        if (this.#blockReconnect && !this.#connected) {
          queueMicrotask(() => this.#closeReceiver(new Error("offline")));
          return Promise.resolve();
        }
        this.#connected = true;
        this.#respond(HELLO_OK);
        return Promise.resolve();
      case "session.open":
        this.#sessionOpenCount++;
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: `session:ack-disconnect-${this.#sessionOpenCount}`,
            serverSeq: this.#watchSeq,
          },
        });
        return Promise.resolve();
      case "session.watch.add":
        this.#watchSeq += 1;
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: this.#watchSeq,
            sync: {
              type: "sync",
              fromSeq: this.#watchSeq - 1,
              toSeq: this.#watchSeq,
              upserts: [],
              removes: [],
            },
          },
        });
        return Promise.resolve();
      case "session.ack":
        this.ackCount += 1;
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: this.#watchSeq },
        });
        return Promise.resolve();
      default:
        throw new Error(`Unhandled message ${message.type}`);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
  }
}

Deno.test("memory v2 client ack scheduler does not retry while disconnected", async () => {
  const time = new FakeTime();
  const transport = new DisconnectableAckTransport();
  const client = await connect({ transport });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-ack-no-spin",
  );

  try {
    // Trigger a watchAdd which will schedule an ack
    await session.watchAdd([{
      id: "root",
      kind: "graph",
      query: {
        roots: [{
          id: "of:doc:1",
          selector: { path: [], schema: false },
        }],
      },
    }]);

    // Let the initial ack flush
    await time.tickAsync(0);
    await time.runMicrotasks();
    const acksBeforeDisconnect = transport.ackCount;

    // Disconnect and block reconnection
    transport.blockReconnect();
    transport.disconnect();

    // Advance time many times — no new acks should be attempted
    for (let i = 0; i < 50; i++) {
      await time.tickAsync(0);
      await time.runMicrotasks();
    }

    assertEquals(
      transport.ackCount,
      acksBeforeDisconnect,
      "no ack sends should occur while disconnected",
    );
  } finally {
    const closePromise = client.close();
    await time.runMicrotasks();
    await time.tickAsync(30_000);
    await time.runMicrotasks();
    await closePromise;
    time.restore();
  }
});

class SessionChangingTransport implements Transport {
  sessionOpenCount = 0;
  transactCount = 0;
  transactSessionIds: string[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  disconnect(): void {
    this.#closeReceiver(new Error("disconnect"));
  }

  send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
      sessionId?: string;
      commit?: { localSeq?: number };
    };

    switch (message.type) {
      case "hello":
        this.#receiver(JSON.stringify(HELLO_OK));
        return Promise.resolve();
      case "session.open": {
        this.sessionOpenCount++;
        // First open: session-A, subsequent: session-B (simulating TTL expiry)
        const sessionId = this.sessionOpenCount === 1
          ? "session-A"
          : "session-B";
        this.#receiver(JSON.stringify({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId,
            serverSeq: 0,
          },
        }));
        return Promise.resolve();
      }
      case "transact": {
        this.transactCount++;
        this.transactSessionIds.push(message.sessionId ?? "");
        if (this.transactCount === 1) {
          // First transact: disconnect before responding (commit becomes outstanding)
          queueMicrotask(() => this.disconnect());
          return Promise.resolve();
        }
        // If we get here, a transact was sent with new session — this is the bug
        this.#receiver(JSON.stringify({
          type: "response",
          requestId: message.requestId!,
          ok: { seq: this.transactCount },
        }));
        return Promise.resolve();
      }
      case "session.ack":
        this.#receiver(JSON.stringify({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: 0 },
        }));
        return Promise.resolve();
      default:
        throw new Error(`Unhandled message: ${message.type}`);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("memory v2 client rejects outstanding commits when session ID changes on reopen", async () => {
  const transport = new SessionChangingTransport();

  const client = await connect({ transport });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-session-id-change",
  );

  try {
    // Send a transact — will be disconnected before response
    const commitPromise = session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:orphan",
        value: { value: { data: "test" } },
      }],
    });

    // The commit should be rejected because the session ID changed
    let rejected = false;
    let resolvedValue: unknown = undefined;
    try {
      resolvedValue = await commitPromise;
    } catch (e) {
      rejected = true;
      const err = e as Error;
      assertEquals(
        err.message.includes("session changed"),
        true,
        `Expected "session changed" but got: ${err.message}`,
      );
    }
    assertEquals(
      rejected,
      true,
      `Expected rejection but got resolved value: ${
        JSON.stringify(resolvedValue)
      }, ` +
        `transactCount=${transport.transactCount}, sessionIds=${
          JSON.stringify(transport.transactSessionIds)
        }`,
    );
    assertEquals(session.sessionId, "session-B");
    assertEquals(transport.sessionOpenCount, 2);
    assertEquals(
      transport.transactCount,
      1,
      "the client must reject the orphaned commit instead of replaying it on the replacement session",
    );
    assertEquals(transport.transactSessionIds, ["session-A"]);
  } finally {
    await client.close();
  }
});

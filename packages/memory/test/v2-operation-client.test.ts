import { ChangeSet } from "@codemirror/state";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { defer } from "@commonfabric/utils/defer";
import { connect, loopback, type Transport } from "../v2/client.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
  OperationCodecRegistry,
} from "../v2/operation-codec.ts";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  toValuePath,
} from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

class ReconnectableOperationTransport implements Transport {
  connectionCount = 0;
  watchSetCount = 0;
  lastOperationAfter: { epoch: number; version: number } | undefined;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<Server["connect"]> | null = null;
  #reconnected = defer<void>();
  #secondWatchSet = defer<void>();
  #reconnectGate: ReturnType<typeof defer<void>> | undefined;

  constructor(private readonly server: Server) {}

  get reconnected(): Promise<void> {
    return this.#reconnected.promise;
  }

  get secondWatchSet(): Promise<void> {
    return this.#secondWatchSet.promise;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type?: string;
      watches?: Array<{
        kind?: string;
        query?: { after?: { epoch: number; version: number } };
      }>;
    };
    if (
      this.#connection === null && this.connectionCount > 0 &&
      this.#reconnectGate !== undefined
    ) {
      await this.#reconnectGate.promise;
      this.#reconnectGate = undefined;
    }
    await this.connection().receive(payload);
    if (message.type === "session.watch.set") {
      this.watchSetCount++;
      this.lastOperationAfter = message.watches?.find((watch) =>
        watch.kind === "operation"
      )?.query?.after;
      if (this.watchSetCount >= 2) this.#secondWatchSet.resolve();
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

  holdReconnect(): void {
    this.#reconnectGate = defer<void>();
  }

  releaseReconnect(): void {
    this.#reconnectGate?.resolve();
  }

  private connection(): ReturnType<Server["connect"]> {
    if (this.#connection === null) {
      this.connectionCount++;
      if (this.connectionCount >= 2) this.#reconnected.resolve();
      this.#connection = this.server.connect((message) => {
        this.#receiver(encodeMemoryBoundary(message));
      });
    }
    return this.#connection;
  }
}

describe("v2-operation-client", () => {
  it("transacts and queries operation history over a memory session", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-client"),
    });
    const client = await connect({ transport: loopback(server) });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-operation-client",
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await space.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:collaborative",
          value: { value: { body: "ac" } },
        }],
      });
      const applied = await space.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "client:1",
          base: null,
          baselineHash: operationBaselineHash("ac"),
          payload: {
            updates: [{
              clientId: "client",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 2).toJSON(),
            }],
          },
        }],
      });
      const queried = await space.queryOperationField({
        id: "of:collaborative",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      });

      expect(applied.operationResolutions?.[0]).toMatchObject({
        submissionId: "client:1",
        to: { epoch: 1, version: 1 },
      });
      expect(queried.field).toMatchObject({
        active: true,
        materialized: "abc",
        cursor: { epoch: 1, version: 1 },
      });
      expect(queried.field.operations).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("delivers operation snapshots through session watches", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-watch"),
      subscriptionRefreshDelayMs: "manual",
    });
    const writerClient = await connect({ transport: loopback(server) });
    const watcherClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-watch";
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:collaborative",
          value: { value: { body: "ac" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:collaborative",
          path: toValuePath(["body"]),
        },
      }]);
      expect(watched.sync.operationFields?.[0]).toMatchObject({
        watchId: "body-operations",
        field: { active: false, materialized: "ac" },
      });
      const syncs = watched.view.subscribeSync();

      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:1",
          base: null,
          baselineHash: operationBaselineHash("ac"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 2).toJSON(),
            }],
          },
        }],
      });
      await server.flushSessions();
      const delivered = await syncs.next();

      expect(delivered.done).toBe(false);
      expect(delivered.value.operationFields?.[0]).toMatchObject({
        watchId: "body-operations",
        field: {
          active: true,
          materialized: "abc",
          cursor: { epoch: 1, version: 1 },
        },
      });
      expect(delivered.value.operationFields?.[0].field.operations)
        .toHaveLength(
          1,
        );

      await writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "release-op-field",
          id: "of:collaborative",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          cursor: { epoch: 1, version: 1 },
        }],
      });
      await server.flushSessions();
      expect((await syncs.next()).value.operationFields?.[0]).toMatchObject({
        watchId: "body-operations",
        field: {
          active: false,
          cursor: null,
          materialized: "abc",
          operations: [],
        },
      });

      await writer.transact({
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:collaborative",
          patches: [{
            op: "replace",
            path: "/value/body",
            value: "ordinary",
          }],
        }],
      });
      await server.flushSessions();
      expect((await syncs.next()).value.operationFields?.[0]).toMatchObject({
        field: {
          active: false,
          cursor: null,
          materialized: "ordinary",
        },
      });

      await writer.transact({
        localSeq: 5,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "delete", id: "of:collaborative" }],
      });
      await server.flushSessions();
      expect((await syncs.next()).value.operationFields?.[0]).toMatchObject({
        field: {
          active: false,
          cursor: null,
          materialized: null,
        },
      });
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("negotiates and executes a configured non-text codec", async () => {
    const operationCodecs = new OperationCodecRegistry([{
      id: "test-counter@1",
      integrate({ materialized, submitted }) {
        const by = submitted !== null && typeof submitted === "object" &&
            !Array.isArray(submitted)
          ? (submitted as { by?: unknown }).by
          : undefined;
        if (
          typeof materialized !== "number" || typeof by !== "number"
        ) {
          throw new Error("counter operation requires numeric values");
        }
        return {
          materialized: materialized + by,
          operations: [{ by }],
        };
      },
    }]);
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-custom-codec"),
      operationCodecs,
    });
    const client = await connect({ transport: loopback(server) });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-operation-custom-codec",
      {},
      testSessionOpenAuthFactory,
    );

    try {
      expect(client.serverFlags?.operationCodecs).toEqual(["test-counter@1"]);
      await space.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:counter",
          value: { value: { count: 1 } },
        }],
      });
      await space.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:counter",
          path: toValuePath(["count"]),
          codec: "test-counter@1",
          submissionId: "counter:1",
          base: null,
          baselineHash: operationBaselineHash(1),
          payload: { by: 2 },
        }],
      });

      expect(
        await space.queryOperationField({
          id: "of:counter",
          path: toValuePath(["count"]),
        }),
      ).toMatchObject({
        field: {
          active: true,
          codec: "test-counter@1",
          materialized: 3,
          operations: [{ payload: { by: 2 } }],
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resumes an operation watch across reconnect without duplicating cursors", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-reconnect"),
    });
    const transport = new ReconnectableOperationTransport(server);
    const watcherClient = await connect({ transport });
    const writerClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-reconnect";
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const originalSessionId = watcher.sessionId;

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:reconnect",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:reconnect",
          path: toValuePath(["body"]),
        },
      }]);
      const syncs = watched.view.subscribeSync();

      transport.disconnect();
      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reconnect",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:1",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });
      await transport.reconnected;

      const resumed = await syncs.next();
      expect(resumed.done).toBe(false);
      expect(resumed.value.operationFields).toEqual([{
        watchId: "body-operations",
        field: expect.objectContaining({
          active: true,
          cursor: { epoch: 1, version: 1 },
          materialized: "ab",
          operations: [expect.objectContaining({
            cursor: { epoch: 1, version: 1 },
            submissionId: "writer:1",
          })],
        }),
      }]);
      expect(transport.watchSetCount).toBe(1);
      expect(watcher.sessionId).toBe(originalSessionId);

      await writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reconnect",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:2",
          base: { epoch: 1, version: 1 },
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 2, insert: "c" }, 2).toJSON(),
            }],
          },
        }],
      });
      const next = await syncs.next();
      expect(next.value.operationFields?.[0].field).toMatchObject({
        cursor: { epoch: 1, version: 2 },
        materialized: "abc",
        operations: [{
          cursor: { epoch: 1, version: 2 },
          submissionId: "writer:2",
        }],
      });
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("reinstalls a replaced-session watch from the last delivered cursor", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-reinstall"),
      sessions: new SessionRegistry({ ttlMs: 0 }),
    });
    const transport = new ReconnectableOperationTransport(server);
    const watcherClient = await connect({ transport });
    const writerClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-reinstall";
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:reinstall",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:reinstall",
          path: toValuePath(["body"]),
        },
      }]);
      const syncs = watched.view.subscribeSync();
      await writer.transact({
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reinstall",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:1",
          base: null,
          baselineHash: operationBaselineHash("a"),
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
            }],
          },
        }],
      });
      expect((await syncs.next()).value.operationFields?.[0].field.cursor)
        .toEqual({ epoch: 1, version: 1 });

      transport.disconnect();
      await transport.secondWatchSet;
      expect(transport.lastOperationAfter).toEqual({ epoch: 1, version: 1 });
      const reinstall = await syncs.next();
      expect(reinstall.value.operationFields?.[0].field).toMatchObject({
        cursor: { epoch: 1, version: 1 },
        operations: [],
      });

      await writer.transact({
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: "of:reinstall",
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:2",
          base: { epoch: 1, version: 1 },
          payload: {
            updates: [{
              clientId: "writer",
              changes: ChangeSet.of({ from: 2, insert: "c" }, 2).toJSON(),
            }],
          },
        }],
      });
      expect((await syncs.next()).value.operationFields?.[0].field)
        .toMatchObject({
          cursor: { epoch: 1, version: 2 },
          materialized: "abc",
          operations: [{
            cursor: { epoch: 1, version: 2 },
            submissionId: "writer:2",
          }],
        });
    } finally {
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });

  it("resets a reconnecting watch whose cursor predates retained history", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-operation-retained-reset"),
      operationCheckpointInterval: 2,
    });
    const transport = new ReconnectableOperationTransport(server);
    const watcherClient = await connect({ transport });
    const writerClient = await connect({ transport: loopback(server) });
    const spaceId = "did:key:z6Mk-memory-v2-operation-retained-reset";
    const watcher = await watcherClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      spaceId,
      {},
      testSessionOpenAuthFactory,
    );

    try {
      await writer.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:retained-reset",
          value: { value: { body: "a" } },
        }],
      });
      const watched = await watcher.watchSetSync([{
        id: "body-operations",
        kind: "operation",
        query: {
          id: "of:retained-reset",
          path: toValuePath(["body"]),
        },
      }]);
      const syncs = watched.view.subscribeSync();
      const append = async (version: number, value: string) => {
        await writer.transact({
          localSeq: version + 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained-reset",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: `writer:${version}`,
            base: version === 1 ? null : { epoch: 1, version: version - 1 },
            ...(version === 1
              ? { baselineHash: operationBaselineHash("a") }
              : {}),
            payload: {
              updates: [{
                clientId: "writer",
                changes: ChangeSet.of(
                  { from: version, insert: value },
                  version,
                ).toJSON(),
              }],
            },
          }],
        });
      };

      await append(1, "b");
      expect((await syncs.next()).value.operationFields?.[0].field.cursor)
        .toEqual({ epoch: 1, version: 1 });

      transport.holdReconnect();
      transport.disconnect();
      await append(2, "c");
      await append(3, "d");
      await append(4, "e");
      transport.releaseReconnect();
      await transport.reconnected;

      expect((await syncs.next()).value.operationFields?.[0].field)
        .toMatchObject({
          active: true,
          cursor: { epoch: 1, version: 4 },
          retainedFrom: { epoch: 1, version: 2 },
          reset: true,
          materialized: "abcde",
          operations: [],
        });
      expect(transport.watchSetCount).toBe(1);

      let staleError: unknown;
      try {
        await writer.transact({
          localSeq: 6,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:retained-reset",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "stale:1",
            base: { epoch: 1, version: 1 },
            payload: {
              updates: [{
                clientId: "stale",
                changes: ChangeSet.of({ from: 2, insert: "!" }, 2).toJSON(),
              }],
            },
          }],
        });
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toMatchObject({
        name: "OpHistoryUnavailableError",
      });
    } finally {
      transport.releaseReconnect();
      await writerClient.close();
      await watcherClient.close();
      await server.close();
    }
  });
});

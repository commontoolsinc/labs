import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { defer } from "@commonfabric/utils/defer";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { Server, SessionRegistry } from "../v2/server.ts";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type EntitySnapshot,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resetPersistentSchedulerStateConfig,
  type SessionSync,
  setPersistentSchedulerStateConfig,
  toDocumentPath,
} from "../v2.ts";
import {
  connect,
  loopback,
  type SessionOpenAuthContext,
  type Transport,
  WatchView,
} from "../v2/client.ts";
import {
  TEST_SESSION_OPEN_AUDIENCE,
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";
import { createGraphFixture } from "./v2-graph.fixture.ts";

const sessionOpenChallenge = {
  value: "challenge:memory-v2-client",
  expiresAt: 1_000_000,
} as const;

const HELLO_OK = {
  type: "hello.ok",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
  sessionOpen: {
    audience: TEST_SESSION_OPEN_AUDIENCE,
    challenge: sessionOpenChallenge,
  },
} as const;

const sessionOpenFor = (id: string) => ({
  audience: TEST_SESSION_OPEN_AUDIENCE,
  challenge: {
    value: `challenge:memory-v2-client:${id}`,
    expiresAt: 1_000_000,
  },
});

const handshakeTransport = (
  helloOk: FabricValue,
  sessionOpen: unknown = undefined,
): Transport => {
  let receiver = (_payload: string) => {};
  return {
    send(payload: string): Promise<void> {
      const message = decodeMemoryBoundary(payload) as {
        type?: string;
        requestId?: string;
      };
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary(helloOk));
        return Promise.resolve();
      }
      if (message.type === "session.open") {
        receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:handshake-context",
            sessionToken: "token:handshake-context",
            serverSeq: 0,
            sessionOpen: sessionOpen ?? sessionOpenFor(message.requestId!),
          },
        }));
      }
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };
};

const asyncHandshakeTransport = (helloOk: FabricValue): Transport => {
  let receiver = (_payload: string) => {};
  return {
    send(payload: string): Promise<void> {
      const message = decodeMemoryBoundary(payload) as {
        type?: string;
      };
      if (message.type === "hello") {
        queueMicrotask(() => receiver(encodeMemoryBoundary(helloOk)));
      }
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };
};

Deno.test("memory v2 client rejects malformed async hello session.open metadata", async () => {
  await assertRejects(
    () =>
      connect({
        transport: asyncHandshakeTransport({
          ...HELLO_OK,
          sessionOpen: {
            audience: TEST_SESSION_OPEN_AUDIENCE,
          },
        }),
      }),
    Error,
    "challenge",
  );
});

Deno.test("memory v2 client rejects malformed hello session.open metadata", async () => {
  const cases: {
    name: string;
    helloOk: FabricValue;
    message: string;
  }[] = [
    {
      name: "missing metadata",
      helloOk: {
        type: "hello.ok",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      },
      message: "authentication metadata",
    },
    {
      name: "non-object metadata",
      helloOk: {
        ...HELLO_OK,
        sessionOpen: "bad",
      },
      message: "malformed",
    },
    {
      name: "non-string audience",
      helloOk: {
        ...HELLO_OK,
        sessionOpen: {
          audience: 123,
          challenge: sessionOpenChallenge,
        },
      },
      message: "malformed",
    },
    {
      name: "non-object challenge",
      helloOk: {
        ...HELLO_OK,
        sessionOpen: {
          audience: TEST_SESSION_OPEN_AUDIENCE,
          challenge: "bad",
        },
      },
      message: "malformed",
    },
    {
      name: "malformed challenge fields",
      helloOk: {
        ...HELLO_OK,
        sessionOpen: {
          audience: TEST_SESSION_OPEN_AUDIENCE,
          challenge: {
            value: 123,
            expiresAt: "soon",
          },
        },
      },
      message: "malformed",
    },
  ];

  for (const testCase of cases) {
    await assertRejects(
      () =>
        connect({
          transport: handshakeTransport(testCase.helloOk),
        }),
      Error,
      testCase.message,
    );
  }
});

Deno.test("memory v2 client rejects a missing session.open challenge", async () => {
  await assertRejects(
    () =>
      connect({
        transport: handshakeTransport({
          ...HELLO_OK,
          sessionOpen: {
            audience: "did:key:z6Mk-memory-v2-client-audience",
          },
        }),
      }),
    Error,
    "challenge",
  );
});

Deno.test("memory v2 client rejects a missing session.open audience", async () => {
  await assertRejects(
    () =>
      connect({
        transport: handshakeTransport({
          ...HELLO_OK,
          sessionOpen: {
            challenge: sessionOpenChallenge,
          },
        }),
      }),
    Error,
    "audience",
  );
});

Deno.test("memory v2 client rejects a missing rotated session.open challenge", async () => {
  const client = await connect({
    transport: handshakeTransport(HELLO_OK, {
      audience: TEST_SESSION_OPEN_AUDIENCE,
    }),
  });
  try {
    await assertRejects(
      () =>
        client.mount(
          "did:key:z6Mk-memory-v2-client-missing-rotated-challenge",
          {},
          testSessionOpenAuthFactory,
        ),
      Error,
      "challenge",
    );
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client rejects a missing rotated session.open audience", async () => {
  const client = await connect({
    transport: handshakeTransport(HELLO_OK, {
      challenge: sessionOpenChallenge,
    }),
  });
  try {
    await assertRejects(
      () =>
        client.mount(
          "did:key:z6Mk-memory-v2-client-missing-rotated-audience",
          {},
          testSessionOpenAuthFactory,
        ),
      Error,
      "audience",
    );
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client passes session.open handshake context to the auth factory", async () => {
  const sessionOpen = {
    audience: "did:key:z6Mk-memory-v2-client-audience",
    challenge: sessionOpenChallenge,
  };
  const client = await connect({
    transport: handshakeTransport({
      ...HELLO_OK,
      sessionOpen,
    }),
  });
  try {
    let captured: unknown;
    await client.mount(
      "did:key:z6Mk-memory-v2-client-handshake-context",
      {},
      (_space, _session, context) => {
        captured = context;
        return undefined;
      },
    );
    assertEquals(captured, sessionOpen);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client rotates session.open challenges between protected mounts", async () => {
  const audience = "did:key:z6Mk-memory-v2-client-rotate-audience";
  const server = new Server({
    store: new URL("memory://memory-v2-client-rotate-challenges"),
    authorizeSessionOpen: () => "did:key:z6Mk-memory-v2-client-principal",
    sessionOpenAuth: {
      audience,
    },
  });
  const client = await connect({
    transport: loopback(server),
  });
  const challenges: string[] = [];
  try {
    const authFactory = (
      _space: string,
      _session: unknown,
      context: SessionOpenAuthContext,
    ) => {
      challenges.push(context.challenge.value);
      return {
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {},
      };
    };
    const first = await client.mount(
      "did:key:z6Mk-memory-v2-client-rotate-one",
      {},
      authFactory,
    );
    const second = await client.mount(
      "did:key:z6Mk-memory-v2-client-rotate-two",
      {},
      authFactory,
    );

    assertEquals(first.serverSeq, 0);
    assertEquals(second.serverSeq, 0);
    assertEquals(challenges.length, 2);
    assertEquals(challenges[0] === challenges[1], false);
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 client watch sets expand to previously hidden graph nodes", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
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
    {},
    testSessionOpenAuthFactory,
  );
  const observer = await observerClient.mount(
    "did:key:z6Mk-memory-v2-client-graph",
    {},
    testSessionOpenAuthFactory,
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
    ...testSessionOpenServerOptions,
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
    {},
    testSessionOpenAuthFactory,
  );
  const observer = await observerClient.mount(
    "did:key:z6Mk-memory-v2-client-watch-add-bootstrap",
    {},
    testSessionOpenAuthFactory,
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
    ...testSessionOpenServerOptions,
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
    {},
    testSessionOpenAuthFactory,
  );
  const observer = await observerClient.mount(
    "did:key:z6Mk-memory-v2-client-watch-sync-effects",
    {},
    testSessionOpenAuthFactory,
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
        scope: "space",
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

Deno.test("memory v2 client conflict errors expose readiness after caught-up sync", async () => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL("memory://memory-v2-client-conflict-ready-to-retry"),
    subscriptionRefreshDelayMs: 20,
  });
  const client = await connect({
    transport: loopback(server),
  });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-client-conflict-ready-to-retry",
    {},
    testSessionOpenAuthFactory,
  );

  try {
    await session.watchSet([{
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

    await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: { value: { version: 1 } },
      }],
    });
    await session.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:1",
        value: { value: { version: 3 } },
      }],
    });

    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 3,
          reads: {
            confirmed: [{
              id: "of:doc:1",
              path: toDocumentPath([]),
              seq: 1,
            }],
            pending: [],
          },
          operations: [{
            op: "set",
            id: "of:doc:1",
            value: { value: { version: 2 } },
          }],
        }),
      Error,
      "stale confirmed read: of:doc:1 at seq 1 conflicted with seq 2",
    );

    assertEquals(error.name, "ConflictError");
    assertEquals(
      (error as Error & { retryAfterSeq?: number }).retryAfterSeq,
      2,
    );
    const readyToRetry = (error as Error & {
      readyToRetry?: () => Promise<void>;
    }).readyToRetry;
    assertExists(readyToRetry);
    await readyToRetry();
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("memory v2 client readyToRetry waits for caught-up local sequence", async () => {
  const transport = new ConflictReadyTransport();
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-memory-v2-ready-delay");

  try {
    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:1",
            value: { value: { version: 2 } },
          }],
        }),
      Error,
      "conflict",
    );
    const readyToRetry = (error as Error & {
      readyToRetry?: () => Promise<void>;
    }).readyToRetry;
    assertExists(readyToRetry);

    let ready = false;
    const readyPromise = readyToRetry().then(() => {
      ready = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(ready, false);

    transport.emitCatchUp();
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(ready, false);

    transport.emitCatchUp(0);
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(ready, false);

    transport.emitCatchUp(1);
    await readyPromise;
    assertEquals(ready, true);
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client readyToRetry rejects after session close", async () => {
  const transport = new ConflictReadyTransport();
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-memory-v2-ready-close");

  const error = await assertRejects(
    () =>
      session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:doc:1",
          value: { value: { version: 2 } },
        }],
      }),
    Error,
    "conflict",
  );
  const readyToRetry = (error as Error & {
    readyToRetry?: () => Promise<void>;
  }).readyToRetry;
  assertExists(readyToRetry);

  await client.close();
  await assertRejects(
    () => readyToRetry(),
    Error,
    "memory session closed",
  );
});

Deno.test("memory v2 client readyToRetry rejects when session ID changes on restore", async () => {
  const transport = new ConflictReadySessionChangingTransport();
  const client = await connect({ transport });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-ready-session-change",
  );

  try {
    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:1",
            value: { value: { version: 2 } },
          }],
        }),
      Error,
      "conflict",
    );
    const readyToRetry = (error as Error & {
      readyToRetry?: () => Promise<void>;
    }).readyToRetry;
    assertExists(readyToRetry);

    let settled = false;
    const readyPromise = readyToRetry().then(
      () => "resolved",
      (error) => error instanceof Error ? error.message : String(error),
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(settled, false);

    await session.restore();
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(settled, true);
    assertEquals(await readyPromise, "session changed: session-A -> session-B");
    assertEquals(session.sessionId, "session-B");
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client readyToRetry rejects when same session ID is not resumed", async () => {
  const transport = new ConflictReadyFreshSameSessionTransport();
  const client = await connect({ transport });
  const session = await client.mount(
    "did:key:z6Mk-memory-v2-ready-fresh-same-session",
  );

  try {
    const error = await assertRejects(
      () =>
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:1",
            value: { value: { version: 2 } },
          }],
        }),
      Error,
      "conflict",
    );
    const readyToRetry = (error as Error & {
      readyToRetry?: () => Promise<void>;
    }).readyToRetry;
    assertExists(readyToRetry);

    let settled = false;
    const readyPromise = readyToRetry().then(
      () => "resolved",
      (error) => error instanceof Error ? error.message : String(error),
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(settled, false);

    await session.restore();
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(settled, true);
    assertEquals(
      await readyPromise,
      "session replaced without resume: session:fresh-same-session",
    );
    assertEquals(session.sessionId, "session:fresh-same-session");
  } finally {
    await client.close();
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

Deno.test("memory v2 client reschedules an ack after a failed send while still connected", async () => {
  const transport = new FailFirstAckTransport();
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-memory-v2-ack-retry");

  try {
    // A watch result acks the observed server seq. The first ack send fails
    // with an error response (the connection stays up), so the ack flush's
    // finally reschedules a retry.
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

    // Wait for the rescheduled retry to be accepted — event-driven, no sleep.
    await transport.ackSucceeded;
    // One failed attempt, then the rescheduled attempt that succeeded.
    assertEquals(transport.ackAttempts, 2);
    // A failed ack while connected must not drop the connection.
    assertEquals(client.isConnected(), true);
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

Deno.test("memory v2 watch view batches structural syncs deterministically", () => {
  const view = WatchView.fromSync({
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [{
      branch: "",
      id: "of:doc:d",
      seq: 1,
      doc: { value: { label: "d" } },
    }, {
      branch: "",
      id: "of:doc:a",
      seq: 1,
      doc: { value: { label: "a" } },
    }, {
      branch: "",
      id: "of:doc:c",
      seq: 1,
      doc: { value: { label: "c" } },
    }],
    removes: [],
  });

  view.applySync({
    type: "sync",
    fromSeq: 1,
    toSeq: 2,
    upserts: [{
      branch: "",
      id: "of:doc:c",
      seq: 2,
      doc: { value: { label: "c2" } },
    }, {
      branch: "",
      id: "of:doc:b",
      seq: 2,
      doc: { value: { label: "b-old" } },
    }, {
      branch: "",
      id: "of:doc:b",
      seq: 3,
      doc: { value: { label: "b-new" } },
    }, {
      branch: "",
      id: "of:doc:f",
      seq: 2,
      doc: { value: { label: "removed" } },
    }],
    removes: [{
      branch: "",
      id: "of:doc:d",
    }, {
      branch: "",
      id: "of:doc:f",
    }, {
      branch: "",
      id: "of:doc:missing",
    }],
  }, false);

  assertEquals(
    view.entities.map((entity) => entity.id),
    ["of:doc:a", "of:doc:b", "of:doc:c"],
  );
  assertEquals(
    view.entities.find((entity) => entity.id === "of:doc:b")?.document,
    { value: { label: "b-new" } },
  );
  assertEquals(
    view.entities.find((entity) => entity.id === "of:doc:c")?.document,
    { value: { label: "c2" } },
  );
});

Deno.test("memory v2 watch view return clears pending snapshot waiters", async () => {
  const view = WatchView.fromSync({
    type: "sync",
    fromSeq: 0,
    toSeq: 1,
    upserts: [],
    removes: [],
  });

  const canceled = view.subscribe();
  const canceledNext = canceled.next();
  await canceled.return?.();
  assertEquals(await canceledNext, {
    done: true,
    value: undefined,
  });

  const active = view.subscribe();
  const activeNext = active.next();
  view.applySync({
    type: "sync",
    fromSeq: 1,
    toSeq: 2,
    upserts: [{
      branch: "",
      id: "of:doc:active",
      seq: 2,
      doc: { value: { label: "active" } },
    }],
    removes: [],
  }, true);

  const snapshot = await activeNext;
  assertEquals(snapshot.done, false);
  assertEquals(
    snapshot.value.entities.map((entity: EntitySnapshot) => entity.id),
    ["of:doc:active"],
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
  #reconnected = defer<void>();
  #secondWatchSet = defer<void>();

  constructor(private readonly server: Server) {}

  /** Resolves when a second connection is opened (reconnect). */
  get reconnected(): Promise<void> {
    return this.#reconnected.promise;
  }

  /** Resolves when a second watch set is installed. */
  get secondWatchSet(): Promise<void> {
    return this.#secondWatchSet.promise;
  }

  async send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as { type?: string };
    await this.connection().receive(payload);
    if (message.type === "session.watch.set") {
      this.watchSetCount++;
      if (this.watchSetCount >= 2) {
        this.#secondWatchSet.resolve();
      }
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
      if (this.connectionCount >= 2) {
        this.#reconnected.resolve();
      }
      this.#connection = this.server.connect((message: FabricValue) => {
        this.#receiver(encodeMemoryBoundary(message));
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

    const message = decodeMemoryBoundary(payload) as {
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
            sessionOpen: sessionOpenFor(message.requestId!),
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

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

class DelayedTransactTransport implements Transport {
  transactLocalSeqs: number[] = [];
  #receiver: (payload: string) => void = () => {};
  #heldResponses: Array<() => void> = [];
  #twoTransacts = defer<void>();

  /** Resolves when two transacts have been received. */
  get twoTransacts(): Promise<void> {
    return this.#twoTransacts.promise;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(): void {}

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
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
            sessionOpen: sessionOpenFor(message.requestId!),
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
        if (this.transactLocalSeqs.length === 2) {
          this.#twoTransacts.resolve();
        }
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

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

class ConflictReadyTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #space = "";
  #sessionId = "session:conflict-ready";

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(): void {}

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      space?: string;
    };
    if (message.space !== undefined) {
      this.#space = message.space;
    }

    switch (message.type) {
      case "hello":
        this.#respond(HELLO_OK);
        return Promise.resolve();
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: this.#sessionId,
            sessionToken: "token:conflict-ready",
            serverSeq: 0,
            sessionOpen: sessionOpenFor(message.requestId!),
          },
        });
        return Promise.resolve();
      case "session.ack":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: 2 },
        });
        return Promise.resolve();
      case "transact":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          error: {
            name: "ConflictError",
            message: "conflict",
            retryAfterSeq: 2,
          },
        });
        return Promise.resolve();
      default:
        throw new Error(`Unhandled conflict-ready message: ${message.type}`);
    }
  }

  emitCatchUp(caughtUpLocalSeq?: number): void {
    this.#respond({
      type: "session/effect",
      space: this.#space,
      sessionId: this.#sessionId,
      effect: {
        type: "sync",
        fromSeq: 0,
        toSeq: 2,
        ...(caughtUpLocalSeq !== undefined ? { caughtUpLocalSeq } : {}),
        upserts: [],
        removes: [],
      },
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

class ConflictReadySessionChangingTransport implements Transport {
  #receiver: (payload: string) => void = () => {};
  #openCount = 0;

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(): void {}

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };

    switch (message.type) {
      case "hello":
        this.#respond(HELLO_OK);
        return Promise.resolve();
      case "session.open": {
        this.#openCount += 1;
        const sessionId = this.#openCount === 1 ? "session-A" : "session-B";
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId,
            sessionToken: `token:${sessionId}`,
            serverSeq: 0,
            sessionOpen: sessionOpenFor(message.requestId!),
          },
        });
        return Promise.resolve();
      }
      case "transact":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          error: {
            name: "ConflictError",
            message: "conflict",
            retryAfterSeq: 2,
          },
        });
        return Promise.resolve();
      default:
        throw new Error(
          `Unhandled conflict-ready session-changing message: ${message.type}`,
        );
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

class ConflictReadyFreshSameSessionTransport implements Transport {
  #receiver: (payload: string) => void = () => {};

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(): void {}

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
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
            sessionId: "session:fresh-same-session",
            sessionToken: "token:fresh-same-session",
            serverSeq: 0,
            sessionOpen: sessionOpenFor(message.requestId!),
          },
        });
        return Promise.resolve();
      case "transact":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          error: {
            name: "ConflictError",
            message: "conflict",
            retryAfterSeq: 2,
          },
        });
        return Promise.resolve();
      default:
        throw new Error(
          `Unhandled conflict-ready fresh-session message: ${message.type}`,
        );
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
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
    const message = decodeMemoryBoundary(payload) as {
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
            sessionOpen: sessionOpenFor(message.requestId!),
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

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
  }
}

// Rejects the FIRST session.ack with an error response but stays connected, so
// the ack flush throws and its finally reschedules a retry (client scheduleAck).
// The second ack is accepted.
class FailFirstAckTransport implements Transport {
  ackAttempts = 0;
  #watchSeq = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #ackSucceeded = defer<void>();

  /** Resolves when a session.ack is accepted (the retry after the first fails). */
  get ackSucceeded(): Promise<void> {
    return this.#ackSucceeded.promise;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
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
            sessionId: "session:fail-first-ack",
            serverSeq: 0,
            sessionOpen: sessionOpenFor(message.requestId!),
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
        this.ackAttempts += 1;
        if (this.ackAttempts === 1) {
          // Reject the ack, but leave the connection open.
          this.#respond({
            type: "response",
            requestId: message.requestId!,
            error: { name: "AckRejected", message: "ack rejected once" },
          });
        } else {
          this.#respond({
            type: "response",
            requestId: message.requestId!,
            ok: { serverSeq: this.#watchSeq },
          });
          this.#ackSucceeded.resolve();
        }
        return Promise.resolve();
      default:
        throw new Error(`Unhandled message ${message.type}`);
    }
  }

  close(): Promise<void> {
    this.#closeReceiver();
    return Promise.resolve();
  }

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
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
    const message = decodeMemoryBoundary(payload) as {
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
            sessionOpen: sessionOpenFor(message.requestId!),
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

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
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
    const message = decodeMemoryBoundary(payload) as {
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
        this.#receiver(encodeMemoryBoundary(HELLO_OK));
        return Promise.resolve();
      case "session.open":
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:controlled",
            serverSeq: 0,
            sessionOpen: sessionOpenFor(message.requestId!),
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
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };

    if (message.type === "hello") {
      this.#receiver(encodeMemoryBoundary(HELLO_OK));
      return Promise.resolve();
    }

    if (message.type === "session.open") {
      this.#closeReceiver(
        new DOMException("memory transport closed", "NetworkError") as Error,
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
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      commit?: { localSeq?: number };
    };

    switch (message.type) {
      case "hello":
        this.#receiver(encodeMemoryBoundary(HELLO_OK));
        return Promise.resolve();
      case "session.open":
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:close-on-applied-commit",
            serverSeq: 0,
            sessionOpen: sessionOpenFor(message.requestId!),
          },
        }));
        return Promise.resolve();
      case "session.ack":
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: message.commit?.localSeq ?? 0,
          },
        }));
        return Promise.resolve();
      case "transact":
        this.#receiver(encodeMemoryBoundary({
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
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-client-reconnect"),
    });
    const transport = new ReconnectableLoopbackTransport(server);
    const client = await connect({ transport });
    const writerClient = await connect({
      transport: loopback(server),
    });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-client-reconnect",
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      "did:key:z6Mk-memory-v2-client-reconnect",
      {},
      testSessionOpenAuthFactory,
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
      await transport.reconnected;
      const resumed = await syncs.next();
      const snapshot = await nextWithTimeout(snapshots);

      assertEquals(resumed.done, false);
      assertEquals(resumed.value.upserts, [{
        branch: "",
        id: "of:doc:1",
        scope: "space",
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

Deno.test("memory v2 client emits empty caught-up syncs after resume", async () => {
  const transport = new EmptyCaughtUpResumeTransport();
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-empty-caught-up-resume");

  try {
    const view = await session.watchSet([{
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

    transport.disconnect();
    await transport.reopened;

    const caughtUp = await nextWithTimeout(syncs);
    assertEquals(caughtUp.done, false);
    assertEquals(caughtUp.value, {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      caughtUpLocalSeq: 1,
      upserts: [],
      removes: [],
    });
  } finally {
    await client.close();
  }
});

Deno.test("memory v2 client forwards a top-level-only caught-up seq on resume", async () => {
  // Regression for the dual-channel strand: when a resume promotes
  // caughtUpLocalSeq via the top-level SessionOpenResult field but NOT via a
  // sync (the server already drained the pending catch-up before the lost
  // send), WatchView subscribers (runner storage) must still observe it, or
  // their conflict-retry read-repair waiters strand forever.
  const transport = new TopLevelCaughtUpResumeTransport();
  const client = await connect({ transport });
  const session = await client.mount("did:key:z6Mk-top-level-caught-up-resume");

  try {
    const view = await session.watchSet([{
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

    transport.disconnect();
    await transport.reopened;

    const caughtUp = await nextWithTimeout(syncs);
    assertEquals(caughtUp.done, false);
    assertEquals(caughtUp.value, {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      caughtUpLocalSeq: 4,
      upserts: [],
      removes: [],
    });
  } finally {
    await client.close();
  }
});

class TopLevelCaughtUpResumeTransport implements Transport {
  openCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #openedSession = false;
  #closed = false;
  #reopened = defer<void>();

  /** Resolves when the connection is reopened (openCount reaches 2). */
  get reopened(): Promise<void> {
    return this.#reopened.promise;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };

    switch (message.type) {
      case "hello":
        this.openCount += 1;
        if (this.openCount >= 2) {
          this.#reopened.resolve();
        }
        this.#closed = false;
        this.#receiver(encodeMemoryBoundary(HELLO_OK));
        return Promise.resolve();
      case "session.open": {
        const resumed = this.#openedSession;
        this.#openedSession = true;
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:top-level-caught-up-resume",
            sessionToken: "token:top-level-caught-up-resume",
            serverSeq: 0,
            // Resume carries the caught-up marker ONLY at the top level — no
            // sync — exactly the case that previously stranded the runner.
            ...(resumed ? { resumed: true, caughtUpLocalSeq: 4 } : {}),
            sessionOpen: sessionOpenFor(message.requestId!),
          },
        }));
        return Promise.resolve();
      }
      case "session.watch.set":
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: 0,
            sync: {
              type: "sync",
              fromSeq: 0,
              toSeq: 0,
              upserts: [],
              removes: [],
            },
          },
        }));
        return Promise.resolve();
      case "session.ack":
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: 0 },
        }));
        return Promise.resolve();
      default:
        throw new Error(
          `Unhandled top-level-caught-up message: ${message.type}`,
        );
    }
  }

  disconnect(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeReceiver(new Error("disconnect"));
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }
}

class EmptyCaughtUpResumeTransport implements Transport {
  openCount = 0;
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #openedSession = false;
  #closed = false;
  #reopened = defer<void>();

  /** Resolves when the connection is reopened (openCount reaches 2). */
  get reopened(): Promise<void> {
    return this.#reopened.promise;
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  send(payload: string): Promise<void> {
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
    };

    switch (message.type) {
      case "hello":
        this.openCount += 1;
        if (this.openCount >= 2) {
          this.#reopened.resolve();
        }
        this.#closed = false;
        this.#receiver(encodeMemoryBoundary(HELLO_OK));
        return Promise.resolve();
      case "session.open": {
        const resumed = this.#openedSession;
        this.#openedSession = true;
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:empty-caught-up-resume",
            sessionToken: "token:empty-caught-up-resume",
            serverSeq: 0,
            ...(resumed
              ? {
                resumed: true,
                caughtUpLocalSeq: 1,
                sync: {
                  type: "sync",
                  fromSeq: 0,
                  toSeq: 0,
                  caughtUpLocalSeq: 1,
                  upserts: [],
                  removes: [],
                },
              }
              : {}),
            sessionOpen: sessionOpenFor(message.requestId!),
          },
        }));
        return Promise.resolve();
      }
      case "session.watch.set":
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            serverSeq: 0,
            sync: {
              type: "sync",
              fromSeq: 0,
              toSeq: 0,
              upserts: [],
              removes: [],
            },
          },
        }));
        return Promise.resolve();
      case "session.ack":
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: { serverSeq: 0 },
        }));
        return Promise.resolve();
      default:
        throw new Error(`Unhandled empty-caught-up message: ${message.type}`);
    }
  }

  disconnect(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeReceiver(new Error("disconnect"));
  }

  close(): Promise<void> {
    this.disconnect();
    return Promise.resolve();
  }
}

Deno.test(
  "memory v2 client does not restore a closed session after reconnect",
  async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://memory-v2-client-closed-session-reconnect"),
      sessions: new SessionRegistry({ ttlMs: 0 }),
    });
    const transport = new ReconnectableLoopbackTransport(server);
    const client = await connect({ transport });
    const space = await client.mount(
      "did:key:z6Mk-memory-v2-client-closed-session-reconnect",
      {},
      testSessionOpenAuthFactory,
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
      await transport.reconnected;
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
      ...testSessionOpenServerOptions,
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
      {},
      testSessionOpenAuthFactory,
    );
    const writer = await writerClient.mount(
      "did:key:z6Mk-memory-v2-client-reconnect-expired",
      {},
      testSessionOpenAuthFactory,
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
      await transport.secondWatchSet;

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
      await transport.twoTransacts;
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
    ...testSessionOpenServerOptions,
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
    }, testSessionOpenAuthFactory);
    const initialToken = first.sessionToken;
    assertExists(initialToken);

    const second = await secondClient.mount(space, {
      sessionId: first.sessionId,
      sessionToken: initialToken,
    }, testSessionOpenAuthFactory);
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
        }, testSessionOpenAuthFactory),
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

    // The client is now parked in a 50ms reconnect backoff. Closing cancels
    // that wait at once, so the close settles through microtasks with the
    // clock held still. Were the backoff required to elapse, awaiting the
    // close under fake time would hang, since nothing ticks its timer.
    await client.close();
    assertEquals(transport.helloCount, 3);
  } finally {
    Math.random = originalRandom;
    time.restore();
  }
});

// Answers the first `hello` and leaves every later one hanging: no reply and no
// close event. A reconnect triggered by `disconnect()` then parks the loop
// inside the handshake rather than in a backoff wait.
class HandshakeHangReconnectTransport implements Transport {
  helloCount = 0;
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
    const message = decodeMemoryBoundary(payload) as { type: string };
    if (message.type === "hello") {
      this.helloCount += 1;
      if (this.helloCount === 1) {
        this.#receiver(encodeMemoryBoundary(HELLO_OK));
      }
      return Promise.resolve();
    }
    throw new Error(`Unhandled handshake-hang message: ${message.type}`);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("memory v2 client close ends a reconnect parked in the handshake", async () => {
  const transport = new HandshakeHangReconnectTransport();
  const client = await connect({ transport });

  // Drop the connection. The reconnect loop sends a fresh `hello` that gets no
  // reply, so it is parked awaiting the handshake, with no backoff timer armed.
  transport.disconnect();
  await Promise.resolve();
  assertEquals(transport.helloCount, 2);

  // Closing rejects the in-flight handshake. The loop then reaches the backoff
  // step with the client already closed, which returns without arming a timer,
  // so the close settles through microtasks.
  await client.close();
  assertEquals(client.isConnected(), false);
});

Deno.test("memory v2 client rejects hello.ok when flags disagree", async () => {
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload): Promise<void> {
      const message = decodeMemoryBoundary(payload) as { type?: string };
      if (message.type === "hello") {
        receiver(encodeMemoryBoundary({
          type: "hello.ok",
          protocol: MEMORY_PROTOCOL,
          flags: {
            modernCellRep: !getMemoryProtocolFlags().modernCellRep,
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
    "memory flag mismatch",
  );
});

Deno.test("memory v2 client stores the server's advertised flags (capability handshake)", async () => {
  // An OLD server's hello.ok omits sqliteCommitRowLabelEval: the parsed
  // server flags must read false (the runner's write gate then keeps failing
  // closed), while a current server's advertisement reads true.
  const transportWithFlags = (flags: unknown): Transport => {
    let receiver = (_payload: string) => {};
    return {
      send(payload): Promise<void> {
        const message = decodeMemoryBoundary(payload) as { type?: string };
        if (message.type === "hello") {
          receiver(encodeMemoryBoundary({
            type: "hello.ok",
            protocol: MEMORY_PROTOCOL,
            flags,
            sessionOpen: {
              audience: TEST_SESSION_OPEN_AUDIENCE,
              challenge: sessionOpenChallenge,
            },
          } as FabricValue));
        }
        return Promise.resolve();
      },
      async close() {},
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver() {},
    };
  };

  const current = await connect({
    transport: transportWithFlags(getMemoryProtocolFlags()),
  });
  try {
    assertEquals(current.serverFlags?.sqliteCommitRowLabelEval, true);
  } finally {
    await current.close();
  }

  const legacy = await connect({
    transport: transportWithFlags({
      modernCellRep: getMemoryProtocolFlags().modernCellRep,
    }),
  });
  try {
    assertEquals(legacy.serverFlags?.sqliteCommitRowLabelEval, false);
  } finally {
    await legacy.close();
  }
});

Deno.test("memory v2 writer lookup fails open when the server omits its capability", async () => {
  setPersistentSchedulerStateConfig(true);
  const requestTypes: string[] = [];
  const legacyFlags = {
    ...getMemoryProtocolFlags(),
  } as unknown as Record<string, boolean>;
  delete legacyFlags.schedulerWriterLookup;
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload): Promise<void> {
      const message = decodeMemoryBoundary(payload) as {
        type?: string;
        requestId?: string;
      };
      requestTypes.push(message.type ?? "<missing>");
      switch (message.type) {
        case "hello":
          receiver(encodeMemoryBoundary({
            type: "hello.ok",
            protocol: MEMORY_PROTOCOL,
            flags: legacyFlags,
            sessionOpen: {
              audience: TEST_SESSION_OPEN_AUDIENCE,
              challenge: sessionOpenChallenge,
            },
          }));
          return Promise.resolve();
        case "session.open":
          receiver(encodeMemoryBoundary({
            type: "response",
            requestId: message.requestId!,
            ok: {
              sessionId: "session:writer-capability",
              sessionToken: "token:writer-capability",
              serverSeq: 17,
              sessionOpen: sessionOpenFor(message.requestId!),
            },
          }));
          return Promise.resolve();
        default:
          throw new Error(`unexpected memory request: ${message.type}`);
      }
    },
    async close() {},
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver() {},
  };

  const client = await connect({ transport });
  try {
    assertEquals(client.serverFlags?.schedulerWriterLookup, false);
    const session = await client.mount(
      "did:key:z6Mk-writer-capability-space",
      {},
      testSessionOpenAuthFactory,
    );
    const result = await session.writersForTargets({
      branch: "",
      targets: [{
        id: "of:output",
        path: toDocumentPath(["value"]),
      }],
    });
    assertEquals(result, { serverSeq: 17, writers: [] });
    assertEquals(requestTypes, ["hello", "session.open"]);
  } finally {
    await client.close();
    resetPersistentSchedulerStateConfig();
  }
});

Deno.test("memory v2 writer lookup rechecks capability after reconnect", async () => {
  setPersistentSchedulerStateConfig(true);
  const currentFlags = getMemoryProtocolFlags();
  const legacyFlags = { ...currentFlags } as Record<string, boolean>;
  delete legacyFlags.schedulerWriterLookup;
  const secondHelloSent = defer<void>();
  const releaseLegacyHello = defer<void>();
  let helloCount = 0;
  let writerLookupCount = 0;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  const respond = (message: FabricValue) =>
    receiver(encodeMemoryBoundary(message));
  const transport: Transport & { disconnect(): void } = {
    send(payload): Promise<void> {
      const message = decodeMemoryBoundary(payload) as {
        type?: string;
        requestId?: string;
      };
      switch (message.type) {
        case "hello": {
          helloCount += 1;
          if (helloCount === 1) {
            respond(HELLO_OK);
          } else {
            secondHelloSent.resolve();
            void releaseLegacyHello.promise.then(() =>
              respond({
                ...HELLO_OK,
                flags: legacyFlags,
              })
            );
          }
          return Promise.resolve();
        }
        case "session.open":
          respond({
            type: "response",
            requestId: message.requestId!,
            ok: {
              sessionId: "session:writer-reconnect-capability",
              sessionToken: "token:writer-reconnect-capability",
              serverSeq: helloCount === 1 ? 17 : 23,
              resumed: helloCount > 1,
              sessionOpen: sessionOpenFor(message.requestId!),
            },
          });
          return Promise.resolve();
        case "scheduler.writer.list":
          writerLookupCount += 1;
          respond({
            type: "response",
            requestId: message.requestId!,
            error: {
              name: "ProtocolError",
              message: "legacy server does not support scheduler.writer.list",
            },
          });
          return Promise.resolve();
        default:
          throw new Error(`unexpected memory request: ${message.type}`);
      }
    },
    async close() {},
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
    disconnect() {
      closeReceiver(new Error("switch to legacy server"));
    },
  };

  const client = await connect({ transport });
  try {
    const session = await client.mount(
      "did:key:z6Mk-writer-reconnect-capability-space",
    );
    transport.disconnect();
    await secondHelloSent.promise;
    const lookup = session.writersForTargets({
      branch: "",
      targets: [{
        id: "of:output",
        path: toDocumentPath(["value"]),
      }],
    });
    releaseLegacyHello.resolve();

    assertEquals(await lookup, { serverSeq: 23, writers: [] });
    assertEquals(writerLookupCount, 0);
    assertEquals(client.serverFlags?.schedulerWriterLookup, false);
  } finally {
    releaseLegacyHello.resolve();
    await client.close();
    resetPersistentSchedulerStateConfig();
  }
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
    assertEquals((error as Error).message, "memory transport closed");
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
    const message = decodeMemoryBoundary(payload) as {
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
            sessionOpen: sessionOpenFor(message.requestId!),
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

  #respond(message: FabricValue): void {
    this.#receiver(encodeMemoryBoundary(message));
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
    const message = decodeMemoryBoundary(payload) as {
      type: string;
      requestId?: string;
      sessionId?: string;
      commit?: { localSeq?: number };
    };

    switch (message.type) {
      case "hello":
        this.#receiver(encodeMemoryBoundary(HELLO_OK));
        return Promise.resolve();
      case "session.open": {
        this.sessionOpenCount++;
        // First open: session-A, subsequent: session-B (simulating TTL expiry)
        const sessionId = this.sessionOpenCount === 1
          ? "session-A"
          : "session-B";
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId,
            serverSeq: 0,
            sessionOpen: sessionOpenFor(message.requestId!),
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
        this.#receiver(encodeMemoryBoundary({
          type: "response",
          requestId: message.requestId!,
          ok: { seq: this.transactCount },
        }));
        return Promise.resolve();
      }
      case "session.ack":
        this.#receiver(encodeMemoryBoundary({
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

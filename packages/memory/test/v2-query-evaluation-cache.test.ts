import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  type WatchAddResult,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-eval-cache-test-audience";

const createServer = (store: string) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string"
        ? principal
        : "did:key:z6Mk-memory-v2-eval-cache-principal";
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
  });

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const openSession = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
  label: string,
  principal?: string,
): Promise<string> => {
  await connection.receive(encodeMemoryBoundary({
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
  }));
  const hello = messages.shift() as
    | { type: string; sessionOpen?: SessionOpenAuthMetadata }
    | undefined;
  expect(hello?.type).toBe("hello.ok");
  const sessionOpen = hello!.sessionOpen!;
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: `${label}-open`,
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
    ...(principal === undefined ? {} : { authorization: { principal } }),
  }));
  const opened = messages.shift() as ResponseMessage<{ sessionId: string }>;
  expect(opened.ok).toBeDefined();
  return opened.ok!.sessionId;
};

const watchAdd = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
  sessionId: string,
  label: string,
  roots: { id: string; scope?: string }[],
): Promise<SessionSync> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.watch.add",
    requestId: `${label}-watch`,
    space,
    sessionId,
    watches: [{
      id: `${label}-watch-id`,
      kind: "graph",
      query: {
        roots: roots.map((root) => ({
          ...root,
          selector: { path: [], schema: true },
        })),
      },
    }],
  }));
  const response = messages.shift() as ResponseMessage<WatchAddResult>;
  expect(response.ok).toBeDefined();
  return response.ok!.sync;
};

const upsertIds = (sync: SessionSync): string[] =>
  [...sync.upserts.map((upsert) => upsert.id)].toSorted();

const seedDocs = async (
  server: Server,
  messages: ServerMessage[],
  space: string,
  sessionId: string,
  ids: string[],
): Promise<void> => {
  const response = await server.transact({
    type: "transact",
    requestId: crypto.randomUUID(),
    space,
    sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: ids.map((id, index) => ({
        op: "set",
        id,
        value: { value: { n: index + 1 } },
      })),
    },
  });
  expect(response.error).toBeUndefined();
  await tick();
  messages.length = 0;
};

describe("v2 query evaluation cache", () => {
  it("serves a second session's identical watch set without re-evaluating, keeping its delivery live", async () => {
    const space = "did:key:z6Mk-eval-cache-shared";
    const server = createServer("memory://eval-cache-shared");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    let connectionW: ReturnType<Server["connect"]> | undefined;
    try {
      const sessionA = await openSession(connectionA, messagesA, space, "a");
      const sessionB = await openSession(connectionB, messagesB, space, "b");
      await seedDocs(server, messagesA, space, sessionA, [
        "of:doc:1",
        "of:doc:2",
      ]);
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [
          { id: "of:doc:1" },
          { id: "of:doc:2" },
        ],
      );
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [
          { id: "of:doc:1" },
          { id: "of:doc:2" },
        ],
      );
      const after = server.evaluationCacheDiagnostics(space);

      expect(after.misses - before.misses).toBe(1);
      expect(after.hits - before.hits).toBe(1);
      expect(upsertIds(syncB)).toEqual(upsertIds(syncA));

      // The soundness pin: a cache-served session's coverage must deliver
      // exactly like an evaluated one. A THIRD session writes (a writer's
      // own change is not echoed back to it), and the update must reach
      // both watchers — the evaluated one and the cache-served one alike.
      const messagesW: ServerMessage[] = [];
      connectionW = server.connect((message) => messagesW.push(message));
      const sessionW = await openSession(connectionW, messagesW, space, "w");
      messagesA.length = 0;
      messagesB.length = 0;
      const write = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionW,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:1", value: { value: { n: 99 } } },
          ],
        },
      });
      expect(write.error).toBeUndefined();
      await server.flushSessions();
      await tick();

      const delivered = (messages: ServerMessage[]): boolean =>
        messages.some((message) =>
          message.type === "session/effect" &&
          (message as { effect?: SessionSync }).effect?.upserts.some(
            (upsert) => upsert.id === "of:doc:1",
          )
        );
      expect(delivered(messagesA)).toBe(true);
      expect(delivered(messagesB)).toBe(true);
    } finally {
      connectionA.close();
      connectionB.close();
      connectionW?.close();
    }
  });

  it("rotates on a commit so a later evaluation sees current state", async () => {
    const space = "did:key:z6Mk-eval-cache-rotate";
    const server = createServer("memory://eval-cache-rotate");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(connectionA, messagesA, space, "a");
      const sessionB = await openSession(connectionB, messagesB, space, "b");
      await seedDocs(server, messagesA, space, sessionA, [
        "of:doc:1",
      ]);
      messagesB.length = 0;

      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [
          { id: "of:doc:1" },
        ],
      );
      expect(syncA.upserts.length).toBe(1);

      const write = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:1", value: { value: { n: 42 } } },
          ],
        },
      });
      expect(write.error).toBeUndefined();
      await tick();

      const before = server.evaluationCacheDiagnostics(space);
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [
          { id: "of:doc:1" },
        ],
      );
      const after = server.evaluationCacheDiagnostics(space);

      expect(after.hits - before.hits).toBe(0);
      expect(after.rotations - before.rotations).toBeGreaterThanOrEqual(1);
      const upsert = syncB.upserts.find((entry) => entry.id === "of:doc:1");
      expect(upsert).toBeDefined();
      expect(
        (upsert!.doc as { value?: { n?: number } } | undefined)?.value?.n,
      ).toBe(42);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("shares a scope-pure evaluation across principals", async () => {
    const space = "did:key:z6Mk-eval-cache-principals";
    const server = createServer("memory://eval-cache-principals");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(
        connectionA,
        messagesA,
        space,
        "a",
        "did:key:z6Mk-eval-cache-principal-a",
      );
      const sessionB = await openSession(
        connectionB,
        messagesB,
        space,
        "b",
        "did:key:z6Mk-eval-cache-principal-b",
      );
      await seedDocs(server, messagesA, space, sessionA, [
        "of:doc:1",
      ]);
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [{ id: "of:doc:1" }],
      );
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [{ id: "of:doc:1" }],
      );
      const after = server.evaluationCacheDiagnostics(space);

      // The post-crash stampede's shape: different principals, identical
      // space-scoped corpus. One evaluation serves both.
      expect(after.misses - before.misses).toBe(1);
      expect(after.hits - before.hits).toBe(1);
      expect(upsertIds(syncB)).toEqual(upsertIds(syncA));
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("keys a session-scoped evaluation to its identity instead of sharing it", async () => {
    const space = "did:key:z6Mk-eval-cache-scoped";
    const server = createServer("memory://eval-cache-scoped");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(connectionA, messagesA, space, "a");
      const sessionB = await openSession(connectionB, messagesB, space, "b");
      messagesA.length = 0;
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      await watchAdd(connectionA, messagesA, space, sessionA, "a", [
        { id: "of:doc:scoped", scope: "session" },
      ]);
      await watchAdd(connectionB, messagesB, space, sessionB, "b", [
        { id: "of:doc:scoped", scope: "session" },
      ]);
      const after = server.evaluationCacheDiagnostics(space);

      // Two identities, each a miss: the tainted entry never crosses.
      expect(after.misses - before.misses).toBe(2);
      expect(after.hits - before.hits).toBe(0);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("rewrites absent scoped dead-ends to the requester, whose own instance stays deliverable", async () => {
    const space = "did:key:z6Mk-eval-cache-residue";
    const server = createServer("memory://eval-cache-residue");
    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionB = server.connect((message) => messagesB.push(message));
    try {
      const sessionA = await openSession(
        connectionA,
        messagesA,
        space,
        "a",
        "did:key:z6Mk-residue-p1",
      );
      const sessionB = await openSession(
        connectionB,
        messagesB,
        space,
        "b",
        "did:key:z6Mk-residue-p2",
      );
      // A shared doc whose value links to a session-scoped draft nobody
      // has written: the walk dead-ends there, recording a scoped miss —
      // the identity-dependent residue.
      const seed = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:linked",
            value: {
              value: {
                note: "shared",
                draft: {
                  "/": {
                    "link@1": {
                      path: [],
                      id: "of:doc:draft",
                      space,
                      scope: "user",
                    },
                  },
                },
              },
            },
          }],
        },
      });
      expect(seed.error).toBeUndefined();
      await tick();
      messagesA.length = 0;
      messagesB.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      const syncA = await watchAdd(
        connectionA,
        messagesA,
        space,
        sessionA,
        "a",
        [{ id: "of:doc:linked" }],
      );
      const syncB = await watchAdd(
        connectionB,
        messagesB,
        space,
        sessionB,
        "b",
        [{ id: "of:doc:linked" }],
      );
      const after = server.evaluationCacheDiagnostics(space);
      expect(after.misses - before.misses).toBe(1);
      expect(after.hits - before.hits).toBe(1);
      expect(upsertIds(syncB)).toEqual(upsertIds(syncA));

      // The rewrite's reactivity pin: another session of the SAME principal
      // writes that principal's draft instance (a writer's own change is
      // not echoed back to it, so the watcher must be a different session),
      // and the delivery machinery must recognize it through the rewritten
      // miss key. The recording principal's watch must NOT receive it.
      const messagesB2: ServerMessage[] = [];
      const connectionB2 = server.connect((message) =>
        messagesB2.push(message)
      );
      const sessionB2 = await openSession(
        connectionB2,
        messagesB2,
        space,
        "b2",
        "did:key:z6Mk-residue-p2",
      );
      messagesA.length = 0;
      messagesB.length = 0;
      const write = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionB2,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:draft",
            scope: "user",
            value: { value: { d: 1 } },
          }],
        },
      });
      connectionB2.close();
      expect(write.error).toBeUndefined();
      await server.flushSessions();
      await tick();

      const draftDelivered = (messages: ServerMessage[]): boolean =>
        messages.some((message) =>
          message.type === "session/effect" &&
          (message as { effect?: SessionSync }).effect?.upserts.some(
            (upsert) => upsert.id === "of:doc:draft",
          )
        );
      expect(draftDelivered(messagesB)).toBe(true);
      expect(draftDelivered(messagesA)).toBe(false);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("evaluates normally for a requester whose scoped instance already exists", async () => {
    const space = "did:key:z6Mk-eval-cache-present";
    const server = createServer("memory://eval-cache-present");
    const messagesA: ServerMessage[] = [];
    const messagesC: ServerMessage[] = [];
    const connectionA = server.connect((message) => messagesA.push(message));
    const connectionC = server.connect((message) => messagesC.push(message));
    try {
      const sessionA = await openSession(
        connectionA,
        messagesA,
        space,
        "a",
        "did:key:z6Mk-present-p1",
      );
      const sessionC = await openSession(
        connectionC,
        messagesC,
        space,
        "c",
        "did:key:z6Mk-present-p3",
      );
      // Seed the shared linked doc AND C's own draft instance BEFORE any
      // watch, so no rotation separates the evaluations.
      const seed = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:linked",
            value: {
              value: {
                draft: {
                  "/": {
                    "link@1": {
                      path: [],
                      id: "of:doc:draft",
                      space,
                      scope: "user",
                    },
                  },
                },
              },
            },
          }],
        },
      });
      expect(seed.error).toBeUndefined();
      const own = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionC,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:doc:draft",
            scope: "user",
            value: { value: { mine: true } },
          }],
        },
      });
      expect(own.error).toBeUndefined();
      await tick();
      messagesA.length = 0;
      messagesC.length = 0;

      const before = server.evaluationCacheDiagnostics(space);
      await watchAdd(connectionA, messagesA, space, sessionA, "a", [
        { id: "of:doc:linked" },
      ]);
      const syncC = await watchAdd(
        connectionC,
        messagesC,
        space,
        sessionC,
        "c",
        [
          { id: "of:doc:linked" },
        ],
      );
      const after = server.evaluationCacheDiagnostics(space);

      // C's instance EXISTS, so the shared entry does not describe C's
      // reach: the absence probe refuses the share, and C's own
      // evaluation delivers its instance.
      expect(after.misses - before.misses).toBe(2);
      expect(after.hits - before.hits).toBe(0);
      expect(upsertIds(syncC)).toContain("of:doc:draft");
    } finally {
      connectionA.close();
      connectionC.close();
    }
  });

  it("evicts the least-recently-evaluated space's cache beyond the space bound", async () => {
    const server = new Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen() {
        return "did:key:z6Mk-eval-cache-lru-principal";
      },
      sessionOpenAuth: {
        audience: TEST_AUDIENCE,
      },
    });
    const connections: ReturnType<Server["connect"]>[] = [];
    try {
      const spaces = Array.from(
        { length: 9 },
        (_, index) => `did:key:z6Mk-eval-cache-lru-${index}`,
      );
      for (const space of spaces) {
        const messages: ServerMessage[] = [];
        const connection = server.connect((message) => messages.push(message));
        connections.push(connection);
        const sessionId = await openSession(
          connection,
          messages,
          space,
          space.slice(-6),
        );
        await watchAdd(
          connection,
          messages,
          space,
          sessionId,
          space.slice(-6),
          [
            { id: "of:doc:1" },
          ],
        );
      }
      // Nine spaces evaluated against a bound of eight: the first has been
      // evicted (a peek reads empty), the rest retain their entries.
      expect(server.evaluationCacheDiagnostics(spaces[0]).entries).toBe(0);
      expect(server.evaluationCacheDiagnostics(spaces[1]).entries).toBe(1);
      expect(server.evaluationCacheDiagnostics(spaces[8]).entries).toBe(1);
    } finally {
      for (const connection of connections) {
        connection.close();
      }
    }
  });
});

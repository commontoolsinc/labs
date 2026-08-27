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
  connection: ReturnType<Server["connect"]>,
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
      await seedDocs(server, connectionA, messagesA, space, sessionA, [
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
      await seedDocs(server, connectionA, messagesA, space, sessionA, [
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
      await seedDocs(server, connectionA, messagesA, space, sessionA, [
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
});

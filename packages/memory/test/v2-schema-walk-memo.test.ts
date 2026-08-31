import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { applyCommit, open as openEngine } from "../v2/engine.ts";
import { type TrackedGraphState, trackGraph } from "../v2/query.ts";
import {
  CapturingSchemaTracker,
  createSchemaWalkMemoStore,
  SchemaWalkMemoSession,
} from "../v2/schema-walk-memo.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  resolveScopeKey,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  type WatchAddResult,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-walk-memo-test-audience";

const invocationFor = (space: string) => ({
  iss: "did:key:test",
  aud: "did:key:service",
  cmd: "/memory/transact",
  sub: space,
});

const link = (space: string, id: string, scope?: string) => ({
  "/": { "link@1": { path: [], id, space, ...(scope ? { scope } : {}) } },
});

const seed = (
  engine: ReturnType<typeof openEngine> extends Promise<infer E> ? E : never,
  space: string,
  localSeq: number,
  operations: unknown[],
  session: { sessionId: string; principal?: string } = { sessionId: "seed" },
) => {
  applyCommit(engine, {
    ...session,
    invocation: invocationFor(space),
    authorization: { proof: "ok" },
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations,
    },
    // deno-lint-ignore no-explicit-any
  } as any);
};

const QUERY_FOR = (id: string) => ({
  roots: [{ id, selector: { path: [], schema: true } }],
});

/** Order-independent picture of an evaluation's reach, for parity
 * comparisons: tracker keys with selector counts, miss keys, entity keys. */
const reachOf = (state: TrackedGraphState) => ({
  tracker: [...state.tracker]
    .map(([key, selectors]) => [key, [...selectors].length] as const)
    .toSorted((a, b) => a[0] < b[0] ? -1 : 1),
  missed: [...state.missed].map(([key]) => key).toSorted(),
  entities: [...state.entities.keys()].toSorted(),
});

describe("v2 schema walk memo", () => {
  it("re-serves an unchanged corpus without re-traversing it", async () => {
    const space = "did:key:z6Mk-walk-memo-warm";
    const engine = await openEngine({ url: new URL("memory:///walk-memo-1") });
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:c", value: { value: { leaf: 3 } } },
      {
        op: "set",
        id: "of:doc:b",
        value: { value: { next: link(space, "of:doc:c") } },
      },
      {
        op: "set",
        id: "of:doc:a",
        value: { value: { one: link(space, "of:doc:b"), n: 1 } },
      },
    ]);
    const store = createSchemaWalkMemoStore();
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const cold = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    expect(cold.stats.crossTraversalMemoHits).toBe(0);
    expect(store.entries.size).toBeGreaterThan(0);

    const warm = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    expect(warm.stats.crossTraversalMemoHits).toBeGreaterThan(0);
    // A served subtree runs no computation of its own; the DAG-arm
    // counter only moves during real walks.
    expect(warm.stats.dagTraversals).toBeLessThan(cold.stats.dagTraversals);
    expect(reachOf(warm.state)).toEqual(reachOf(cold.state));
  });

  it("recomputes only the changed document's ancestor chain", async () => {
    const space = "did:key:z6Mk-walk-memo-chain";
    const engine = await openEngine({ url: new URL("memory:///walk-memo-2") });
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:d", value: { value: { leaf: "d" } } },
      {
        op: "set",
        id: "of:doc:b",
        value: { value: { next: link(space, "of:doc:d") } },
      },
      { op: "set", id: "of:doc:c", value: { value: { leaf: "c1" } } },
      {
        op: "set",
        id: "of:doc:a",
        value: {
          value: {
            left: link(space, "of:doc:b"),
            right: link(space, "of:doc:c"),
          },
        },
      },
    ]);
    const store = createSchemaWalkMemoStore();
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const cold = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });

    seed(engine, space, 2, [
      { op: "set", id: "of:doc:c", value: { value: { leaf: "c2" } } },
    ]);
    const after = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    // B and D are unchanged and serve from their entries; A and C — the
    // chain from the change to the root — re-traverse.
    expect(after.stats.crossTraversalMemoHits).toBeGreaterThan(0);
    expect(after.stats.dagTraversals).toBeGreaterThan(0);
    expect(after.stats.dagTraversals).toBeLessThan(cold.stats.dagTraversals);
    const c = after.state.entities.get(
      `${space}/space/of:doc:c` as Parameters<
        typeof after.state.entities.get
      >[0],
    );
    expect((c?.document as { value?: { leaf?: string } })?.value?.leaf).toBe(
      "c2",
    );
  });

  it("keys scoped-crossing subtrees to the evaluating identity", async () => {
    const space = "did:key:z6Mk-walk-memo-scoped";
    const engine = await openEngine({ url: new URL("memory:///walk-memo-3") });
    const p1 = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const p2 = { principal: "did:key:z6Mk-wm-p2", sessionId: "wm-s2" };
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:pure", value: { value: { leaf: "shared" } } },
      {
        op: "set",
        id: "of:doc:a",
        value: {
          value: {
            shared: link(space, "of:doc:pure"),
            draft: link(space, "of:doc:draft", "session"),
          },
        },
      },
    ]);
    seed(engine, space, 2, [
      {
        op: "set",
        id: "of:doc:draft",
        scope: "session",
        value: {
          value: { mine: "p1" },
        },
      },
    ], { sessionId: "wm-s1", principal: "did:key:z6Mk-wm-p1" });

    const store = createSchemaWalkMemoStore();
    trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...p1,
      schemaWalkMemo: store,
    });
    const p1Warm = trackGraph(
      space,
      engine,
      QUERY_FOR("of:doc:a"),
      undefined,
      { ...p1, schemaWalkMemo: store },
    );
    expect(p1Warm.stats.crossTraversalMemoHits).toBeGreaterThan(0);

    // The taint key is structural: the scoped-crossing root's entries
    // live only under identity-suffixed keys. Reach-level assertions
    // cannot pin this — instance-resolved child dependencies keep reach
    // correct across identities on their own — the suffix guards the
    // memoized RESULT, which embeds scoped values whenever a selective
    // schema branches on them.
    const rootKeys = [...store.entries.keys()].filter((key) =>
      key.includes("of:doc:a")
    );
    expect(rootKeys.length).toBeGreaterThan(0);
    expect(rootKeys.every((key) => key.includes("|I["))).toBe(true);

    const p2Eval = trackGraph(
      space,
      engine,
      QUERY_FOR("of:doc:a"),
      undefined,
      { ...p2, schemaWalkMemo: store },
    );
    // The pure subtree serves p2; the scoped chain does not cross: p2's
    // reach carries ITS instance's miss, and p1's draft value is not in
    // p2's entities.
    const p2Reach = reachOf(p2Eval.state);
    expect(p2Reach.missed.some((key) => key.includes("wm-s2"))).toBe(true);
    expect(p2Reach.missed.some((key) => key.includes("wm-s1"))).toBe(false);
    expect(
      p2Reach.entities.some((key) => key.includes("of:doc:draft")),
    ).toBe(false);
    expect(
      p2Reach.entities.some((key) => key.includes("of:doc:pure")),
    ).toBe(true);
  });

  it("invalidates through a rewritten pointer document that has no frame of its own", async () => {
    const space = "did:key:z6Mk-walk-memo-pointer";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-ptr"),
    });
    // P is a bare pointer document: the walk reads it while following the
    // redirect chain from A, registering it without giving it a
    // (document, schema) frame — its revision must still bind the entries
    // recorded above it.
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:c1", value: { value: { leaf: "one" } } },
      { op: "set", id: "of:doc:c2", value: { value: { leaf: "two" } } },
      { op: "set", id: "of:doc:p", value: { value: link(space, "of:doc:c1") } },
      {
        op: "set",
        id: "of:doc:a",
        value: { value: { via: link(space, "of:doc:p") } },
      },
    ]);
    const store = createSchemaWalkMemoStore();
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const cold = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    expect(reachOf(cold.state).entities.some((k) => k.includes("of:doc:c1")))
      .toBe(true);

    seed(engine, space, 2, [
      { op: "set", id: "of:doc:p", value: { value: link(space, "of:doc:c2") } },
    ]);
    const after = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    const reach = reachOf(after.state);
    expect(reach.entities.some((k) => k.includes("of:doc:c2"))).toBe(true);
  });

  it("leaves evaluation results identical with the memo off and on", async () => {
    const space = "did:key:z6Mk-walk-memo-parity";
    const engine = await openEngine({ url: new URL("memory:///walk-memo-4") });
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:shared", value: { value: { s: 1 } } },
      {
        op: "set",
        id: "of:doc:left",
        value: { value: { to: link(space, "of:doc:shared") } },
      },
      {
        op: "set",
        id: "of:doc:right",
        value: { value: { to: link(space, "of:doc:shared") } },
      },
      {
        op: "set",
        id: "of:doc:a",
        value: {
          value: {
            l: link(space, "of:doc:left"),
            r: link(space, "of:doc:right"),
            gone: link(space, "of:doc:absent"),
          },
        },
      },
    ]);
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const off = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
    });
    const store = createSchemaWalkMemoStore();
    trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    const warm = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    expect(warm.stats.crossTraversalMemoHits).toBeGreaterThan(0);
    expect(reachOf(warm.state)).toEqual(reachOf(off.state));
  });

  it("holds the entry bound by evicting oldest entries", async () => {
    const space = "did:key:z6Mk-walk-memo-bound";
    const engine = await openEngine({ url: new URL("memory:///walk-memo-5") });
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:c", value: { value: { leaf: 3 } } },
      {
        op: "set",
        id: "of:doc:b",
        value: { value: { next: link(space, "of:doc:c") } },
      },
      {
        op: "set",
        id: "of:doc:a",
        value: { value: { one: link(space, "of:doc:b") } },
      },
    ]);
    const store = createSchemaWalkMemoStore(1);
    trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      principal: "did:key:z6Mk-wm-p1",
      sessionId: "wm-s1",
      schemaWalkMemo: store,
    });
    expect(store.entries.size).toBeLessThanOrEqual(1);
    expect(store.evictions).toBeGreaterThan(0);
  });

  it("keeps a recently served closure ahead of unrelated cold entries", async () => {
    const space = "did:key:z6Mk-walk-memo-closure-lru";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-closure-lru"),
    });
    const coldIds = Array.from(
      { length: 4 },
      (_, index) => `of:doc:cold-${index}`,
    );
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:hot-c", value: { value: { leaf: 3 } } },
      {
        op: "set",
        id: "of:doc:hot-b",
        value: { value: { next: link(space, "of:doc:hot-c") } },
      },
      {
        op: "set",
        id: "of:doc:hot-a",
        value: { value: { next: link(space, "of:doc:hot-b") } },
      },
      ...coldIds.map((id) => ({
        op: "set",
        id,
        value: { value: { leaf: id } },
      })),
      {
        op: "set",
        id: "of:doc:pressure",
        value: { value: { leaf: "new" } },
      },
    ]);
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const store = createSchemaWalkMemoStore();
    trackGraph(space, engine, QUERY_FOR("of:doc:hot-a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    const hotIds = ["of:doc:hot-a", "of:doc:hot-b", "of:doc:hot-c"];
    const hotKeys = [...store.entries.keys()].filter((key) =>
      hotIds.some((id) => key.includes(`|${id}|`))
    );
    expect(hotKeys.length).toBeGreaterThan(1);
    for (const id of coldIds) {
      trackGraph(space, engine, QUERY_FOR(id), undefined, {
        ...identity,
        schemaWalkMemo: store,
      });
    }
    store.maxEntries = store.entries.size;

    const warm = trackGraph(
      space,
      engine,
      QUERY_FOR("of:doc:hot-a"),
      undefined,
      { ...identity, schemaWalkMemo: store },
    );
    expect(warm.stats.crossTraversalMemoHits).toBeGreaterThan(0);
    trackGraph(space, engine, QUERY_FOR("of:doc:pressure"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });

    expect(hotKeys.every((key) => store.entries.has(key))).toBe(true);
    const stillWarm = trackGraph(
      space,
      engine,
      QUERY_FOR("of:doc:hot-a"),
      undefined,
      { ...identity, schemaWalkMemo: store },
    );
    expect(stillWarm.stats.dagTraversals).toBe(0);
  });

  it("retouches descendants when a closure is served twice in one evaluation", async () => {
    const space = "did:key:z6Mk-walk-memo-repeat-lru";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-repeat-lru"),
    });
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:hot-c", value: { value: { leaf: 3 } } },
      {
        op: "set",
        id: "of:doc:hot-b",
        value: { value: { next: link(space, "of:doc:hot-c") } },
      },
      {
        op: "set",
        id: "of:doc:hot-a",
        value: { value: { next: link(space, "of:doc:hot-b") } },
      },
      {
        op: "set",
        id: "of:doc:hot-d",
        value: { value: { next: link(space, "of:doc:hot-b") } },
      },
      { op: "set", id: "of:doc:cold", value: { value: { leaf: "cold" } } },
      {
        op: "set",
        id: "of:doc:pressure",
        value: { value: { leaf: "pressure" } },
      },
    ]);
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const store = createSchemaWalkMemoStore();
    trackGraph(space, engine, QUERY_FOR("of:doc:hot-a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    trackGraph(space, engine, QUERY_FOR("of:doc:hot-d"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    store.maxEntries = store.entries.size + 1;

    // The first root replays A -> B -> C. The cold root is then inserted,
    // and the third root consumes D -> B -> C, reaching B through the
    // already-replayed branch. Pressure after that must evict A, not C: D's
    // whole closure was the most recently consumed one.
    const mixed = trackGraph(
      space,
      engine,
      {
        roots: [
          "of:doc:hot-a",
          "of:doc:cold",
          "of:doc:hot-d",
          "of:doc:pressure",
        ].map((id) => ({ id, selector: { path: [], schema: true } })),
      },
      undefined,
      { ...identity, schemaWalkMemo: store },
    );
    expect(mixed.stats.crossTraversalMemoHits).toBeGreaterThan(0);

    const stillWarm = trackGraph(
      space,
      engine,
      QUERY_FOR("of:doc:hot-d"),
      undefined,
      { ...identity, schemaWalkMemo: store },
    );
    expect(stillWarm.stats.dagTraversals).toBe(0);
  });

  it("delivers through a memo-served watch", async () => {
    const space = "did:key:z6Mk-walk-memo-delivery";
    const server = new Server({
      store: new URL("memory://walk-memo-delivery"),
      experimentalSchemaWalkMemo: true,
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string"
          ? principal
          : "did:key:z6Mk-walk-memo-principal";
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const open = async (
      connection: ReturnType<Server["connect"]>,
      messages: ServerMessage[],
      label: string,
      principal: string,
    ): Promise<string> => {
      await connection.receive(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      }));
      const hello = messages.shift() as {
        type: string;
        sessionOpen?: SessionOpenAuthMetadata;
      };
      expect(hello.type).toBe("hello.ok");
      await connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: `${label}-open`,
        space,
        session: {},
        invocation: {
          aud: hello.sessionOpen!.audience,
          challenge: hello.sessionOpen!.challenge.value,
        },
        authorization: { principal },
      }));
      const opened = messages.shift() as ResponseMessage<{
        sessionId: string;
      }>;
      expect(opened.ok).toBeDefined();
      return opened.ok!.sessionId;
    };
    const watch = async (
      connection: ReturnType<Server["connect"]>,
      messages: ServerMessage[],
      sessionId: string,
      label: string,
    ) => {
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: `${label}-watch`,
        space,
        sessionId,
        watches: [{
          id: `${label}-watch-id`,
          kind: "graph",
          query: QUERY_FOR("of:doc:a"),
        }],
      }));
      const response = messages.shift() as ResponseMessage<WatchAddResult>;
      expect(response.ok).toBeDefined();
      return response.ok!.sync;
    };

    const messagesA: ServerMessage[] = [];
    const messagesB: ServerMessage[] = [];
    const connectionA = server.connect((m) => messagesA.push(m));
    const connectionB = server.connect((m) => messagesB.push(m));
    try {
      const sessionA = await open(connectionA, messagesA, "a", "did:key:a1");
      const sessionB = await open(connectionB, messagesB, "b", "did:key:b1");
      const seedResponse = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:b", value: { value: { n: 1 } } },
            {
              op: "set",
              id: "of:doc:a",
              value: { value: { next: link(space, "of:doc:b") } },
            },
          ],
        },
      });
      expect(seedResponse.error).toBeUndefined();
      await tick();
      messagesA.length = 0;
      messagesB.length = 0;

      await watch(connectionA, messagesA, sessionA, "a");
      // A commit between the watches rotates the whole-evaluation cache,
      // so B's establishment exercises the memo path.
      const rotate = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:unrelated", value: { value: { u: 1 } } },
          ],
        },
      });
      expect(rotate.error).toBeUndefined();
      await tick();
      const syncB = await watch(connectionB, messagesB, sessionB, "b");
      expect(syncB.upserts.map((u) => u.id)).toContain("of:doc:b");
      expect(server.schemaWalkMemoDiagnostics(space).hits).toBeGreaterThan(0);

      messagesB.length = 0;
      const write = await server.transact({
        type: "transact",
        requestId: crypto.randomUUID(),
        space,
        sessionId: sessionA,
        commit: {
          localSeq: 3,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:b", value: { value: { n: 2 } } },
          ],
        },
      });
      expect(write.error).toBeUndefined();
      await server.flushSessions();
      await tick();
      const delivered = messagesB.some((message) =>
        message.type === "session/effect" &&
        (message as { effect?: SessionSync }).effect?.upserts.some(
          (upsert) => upsert.id === "of:doc:b",
        )
      );
      expect(delivered).toBe(true);
    } finally {
      connectionA.close();
      connectionB.close();
    }
  });

  it("reads an absent space's memo diagnostics as empty", () => {
    const server = new Server({
      store: new URL("memory://walk-memo-absent"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: () => "did:key:z6Mk-walk-memo-principal",
      sessionOpenAuth: { audience: TEST_AUDIENCE },
    });
    expect(
      server.schemaWalkMemoDiagnostics("did:key:z6Mk-never-evaluated"),
    ).toEqual({ entries: 0, hits: 0, misses: 0, evictions: 0, poisons: 0 });
  });

  it("evicts the least-recently-evaluated space's memo beyond the space bound", async () => {
    const server = new Server({
      store: new URL("memory://walk-memo-space-lru"),
      experimentalSchemaWalkMemo: true,
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: () => "did:key:z6Mk-walk-memo-lru-principal",
      sessionOpenAuth: { audience: TEST_AUDIENCE },
    });
    const connections: ReturnType<Server["connect"]>[] = [];
    try {
      const spaces = Array.from(
        { length: 9 },
        (_, index) => `did:key:z6Mk-walk-memo-lru-${index}`,
      );
      for (const space of spaces) {
        const messages: ServerMessage[] = [];
        const connection = server.connect((message) => messages.push(message));
        connections.push(connection);
        await connection.receive(encodeMemoryBoundary({
          type: "hello",
          protocol: MEMORY_PROTOCOL,
          flags: getMemoryProtocolFlags(),
        }));
        const hello = messages.shift() as {
          sessionOpen?: SessionOpenAuthMetadata;
        };
        await connection.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: `${space}-open`,
          space,
          session: {},
          invocation: {
            aud: hello.sessionOpen!.audience,
            challenge: hello.sessionOpen!.challenge.value,
          },
        }));
        const opened = messages.shift() as ResponseMessage<
          { sessionId: string }
        >;
        expect(opened.ok).toBeDefined();
        // A space with no documents opens no frames and stores nothing, so
        // each space needs something for the walk to memoize.
        const seeded = await server.transact({
          type: "transact",
          requestId: crypto.randomUUID(),
          space,
          sessionId: opened.ok!.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:doc:1",
              value: { value: { leaf: 1 } },
            }],
          },
        });
        expect(seeded.error).toBeUndefined();
        messages.length = 0;
        await connection.receive(encodeMemoryBoundary({
          type: "session.watch.add",
          requestId: `${space}-watch`,
          space,
          sessionId: opened.ok!.sessionId,
          watches: [{
            id: `${space}-watch-id`,
            kind: "graph",
            query: QUERY_FOR("of:doc:1"),
          }],
        }));
        const response = messages.shift() as ResponseMessage<WatchAddResult>;
        expect(response.ok).toBeDefined();
      }
      // Nine spaces evaluated against a bound of eight: the first space's
      // memo is gone, and a peek at it reads empty rather than minting one.
      expect(server.schemaWalkMemoDiagnostics(spaces[0]).entries).toBe(0);
      expect(
        server.schemaWalkMemoDiagnostics(spaces[8]).entries,
      ).toBeGreaterThan(0);
    } finally {
      for (const connection of connections) connection.close();
    }
  });

  it("refuses a negative entry bound instead of evicting forever", () => {
    expect(() => createSchemaWalkMemoStore(-1)).toThrow(RangeError);
    expect(() => createSchemaWalkMemoStore(1.5)).toThrow(RangeError);
    expect(createSchemaWalkMemoStore(0).maxEntries).toBe(0);
  });

  it("stores nothing for a query root naming an explicit scope instance", async () => {
    const space = "did:key:z6Mk-walk-memo-explicit";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-explicit"),
    });
    seed(engine, space, 1, [
      {
        op: "set",
        id: "of:doc:owned",
        scope: "session",
        value: { value: { leaf: "a" } },
      },
    ], { sessionId: "wm-s1", principal: "did:key:z6Mk-wm-p1" });
    const store = createSchemaWalkMemoStore();
    // A lease holder reads a named instance rather than its own, so memo
    // keys built from the evaluating identity would name the wrong
    // document; the whole class bypasses.
    trackGraph(
      space,
      engine,
      {
        roots: [{
          id: "of:doc:owned",
          scope: "session",
          entityScopeKey: resolveScopeKey("session", {
            principal: "did:key:z6Mk-wm-p1",
            sessionId: "wm-s1",
          }),
          selector: { path: [], schema: true },
        }],
      },
      undefined,
      {
        principal: "did:key:z6Mk-wm-p2",
        sessionId: "wm-s2",
        schemaWalkMemo: store,
      },
    );
    expect(store.entries.size).toBe(0);
  });

  it("invalidates a parent whose grandchild changed", async () => {
    const space = "did:key:z6Mk-walk-memo-grandchild";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-grandchild"),
    });
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:c", value: { value: { leaf: "c1" } } },
      {
        op: "set",
        id: "of:doc:b",
        value: { value: { next: link(space, "of:doc:c") } },
      },
      {
        op: "set",
        id: "of:doc:a",
        value: { value: { next: link(space, "of:doc:b") } },
      },
    ]);
    const store = createSchemaWalkMemoStore();
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    // Only the deepest document changes: A's and B's own revisions still
    // match, so invalidation has to travel up through the child links.
    seed(engine, space, 2, [
      { op: "set", id: "of:doc:c", value: { value: { leaf: "c2" } } },
    ]);
    const after = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    const c = after.state.entities.get(
      `${space}/space/of:doc:c` as Parameters<
        typeof after.state.entities.get
      >[0],
    );
    expect((c?.document as { value?: { leaf?: string } })?.value?.leaf).toBe(
      "c2",
    );
  });

  it("stops serving a subtree when one of its siblings is gone", async () => {
    const space = "did:key:z6Mk-walk-memo-siblings";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-siblings"),
    });
    // R -> A -> {B, C}: A is deep enough to be served from an entry, and
    // its two subtrees let one validate before the other fails.
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:b", value: { value: { leaf: "b" } } },
      { op: "set", id: "of:doc:c", value: { value: { leaf: "c1" } } },
      {
        op: "set",
        id: "of:doc:a",
        value: {
          value: {
            left: link(space, "of:doc:b"),
            right: link(space, "of:doc:c"),
          },
        },
      },
      {
        op: "set",
        id: "of:doc:r",
        value: { value: { next: link(space, "of:doc:a") } },
      },
    ]);
    const store = createSchemaWalkMemoStore();
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const off = trackGraph(space, engine, QUERY_FOR("of:doc:r"), undefined, {
      ...identity,
    });
    trackGraph(space, engine, QUERY_FOR("of:doc:r"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    seed(engine, space, 2, [
      { op: "set", id: "of:doc:c", value: { value: { leaf: "c2" } } },
    ]);
    const after = trackGraph(space, engine, QUERY_FOR("of:doc:r"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    const plainAfter = trackGraph(
      space,
      engine,
      QUERY_FOR("of:doc:r"),
      undefined,
      { ...identity },
    );
    expect(reachOf(after.state)).toEqual(reachOf(plainAfter.state));
    expect(reachOf(off.state).entities.length).toBe(
      reachOf(after.state).entities.length,
    );
    const c = after.state.entities.get(
      `${space}/space/of:doc:c` as Parameters<
        typeof after.state.entities.get
      >[0],
    );
    expect((c?.document as { value?: { leaf?: string } })?.value?.leaf).toBe(
      "c2",
    );
  });

  it("re-records a miss when its referrer is rewritten to another absent target", async () => {
    const space = "did:key:z6Mk-walk-memo-referrer";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-referrer"),
    });
    // The referrer's link dead-ends: nothing was ever written at the
    // target, so only the REFERRER's revision distinguishes the two
    // states of this graph.
    seed(engine, space, 1, [
      {
        op: "set",
        id: "of:doc:p",
        value: { value: { to: link(space, "of:doc:absent1") } },
      },
      {
        op: "set",
        id: "of:doc:a",
        value: { value: { via: link(space, "of:doc:p") } },
      },
    ]);
    const store = createSchemaWalkMemoStore();
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const cold = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    expect(reachOf(cold.state).missed.some((k) => k.includes("absent1")))
      .toBe(true);

    seed(engine, space, 2, [
      {
        op: "set",
        id: "of:doc:p",
        value: { value: { to: link(space, "of:doc:absent2") } },
      },
    ]);
    const after = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    const missed = reachOf(after.state).missed;
    expect(missed.some((k) => k.includes("absent2"))).toBe(true);
    expect(missed.some((k) => k.includes("absent1"))).toBe(false);
  });

  it("serves a repeated schema-narrowed subtree and keeps its reach", async () => {
    const space = "did:key:z6Mk-walk-memo-schema";
    const engine = await openEngine({
      url: new URL("memory:///walk-memo-schema"),
    });
    const shapedLink = (id: string) => ({
      "/": {
        "link@1": {
          path: [],
          id,
          space,
          schema: {
            type: "object",
            properties: { leaf: { type: "string" } },
          },
        },
      },
    });
    // Both arms narrow the SAME document under the SAME schema, so the
    // second visit consumes the first's result rather than re-entering
    // it — the dependency the entry must record to stay invalidatable.
    seed(engine, space, 1, [
      { op: "set", id: "of:doc:shared", value: { value: { leaf: "one" } } },
      {
        op: "set",
        id: "of:doc:a",
        value: {
          value: {
            l: shapedLink("of:doc:shared"),
            r: shapedLink("of:doc:shared"),
          },
        },
      },
    ]);
    const store = createSchemaWalkMemoStore();
    const identity = { principal: "did:key:z6Mk-wm-p1", sessionId: "wm-s1" };
    const off = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
    });
    const cold = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    expect(cold.stats.schemaTraversals).toBeGreaterThan(0);
    expect(reachOf(cold.state)).toEqual(reachOf(off.state));

    const warm = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    expect(warm.stats.crossTraversalMemoHits).toBeGreaterThan(0);
    expect(reachOf(warm.state)).toEqual(reachOf(off.state));

    seed(engine, space, 2, [
      { op: "set", id: "of:doc:shared", value: { value: { leaf: "two" } } },
    ]);
    const after = trackGraph(space, engine, QUERY_FOR("of:doc:a"), undefined, {
      ...identity,
      schemaWalkMemo: store,
    });
    const shared = after.state.entities.get(
      `${space}/space/of:doc:shared` as Parameters<
        typeof after.state.entities.get
      >[0],
    );
    expect(
      (shared?.document as { value?: { leaf?: string } })?.value?.leaf,
    ).toBe("two");
  });

  describe("frame bookkeeping", () => {
    const openSession = async (label: string) => {
      const space = `did:key:z6Mk-walk-memo-frames-${label}`;
      const engine = await openEngine({
        url: new URL(`memory:///walk-memo-frames-${label}`),
      });
      seed(engine, space, 1, [
        { op: "set", id: "of:doc:x", value: { value: { leaf: 1 } } },
      ]);
      const store = createSchemaWalkMemoStore();
      const tracker = new CapturingSchemaTracker();
      const session = new SchemaWalkMemoSession({
        store,
        engine,
        space,
        branch: "",
        identity: {
          principal: "did:key:z6Mk-wm-p1",
          sessionId: "wm-s1",
        },
        tracker,
      });
      const doc = (id: string) =>
        ({
          address: {
            id,
            space,
            scope: "space" as const,
            type: "application/json",
            path: [],
          },
          value: { value: {} },
          // deno-lint-ignore no-explicit-any
        }) as any;
      return { session, store, tracker, doc };
    };

    it("stores nothing for a computation cut short by a value cycle", async () => {
      const { session, store, doc } = await openSession("poison");
      session.enter(doc("of:doc:x"), true);
      session.poison();
      session.exit(doc("of:doc:x"), true, { ok: null });
      expect(store.entries.size).toBe(0);
      expect(store.poisons).toBe(1);
    });

    it("stores nothing for a frame whose child computation was abandoned", async () => {
      const { session, store, doc } = await openSession("abandon");
      session.enter(doc("of:doc:x"), true);
      session.enter(doc("of:doc:x"), false);
      session.abandon();
      session.exit(doc("of:doc:x"), true, { ok: null });
      expect(store.entries.size).toBe(0);
    });

    it("stores nothing for a frame whose child was cut short by a cycle", async () => {
      const { session, store, doc } = await openSession("poison-parent");
      session.enter(doc("of:doc:x"), true);
      session.enter(doc("of:doc:x"), false);
      session.poison();
      session.exit(doc("of:doc:x"), false, { ok: null });
      session.exit(doc("of:doc:x"), true, { ok: null });
      expect(store.entries.size).toBe(0);
    });

    it("records nothing while no computation is open", async () => {
      const { session, store, doc } = await openSession("no-frame");
      const recorded: string[] = [];
      const record = session.wrapMissRecorder((missKey) => {
        recorded.push(missKey);
      });
      // Reach outside any (document, schema) computation — a root's own
      // registrations and misses belong to no frame — attributes to
      // nothing, but still reaches the walk's own recorder.
      record(
        "space/space/of:doc:absent",
        { path: [], schema: true },
        undefined,
      );
      session.dependency(doc("of:doc:other"), true);
      session.exit(doc("of:doc:x"), true, { ok: null });
      expect(store.entries.size).toBe(0);
      expect(recorded).toEqual(["space/space/of:doc:absent"]);
    });

    it("detaches capture before a tracker becomes live state", async () => {
      const { session, store, tracker, doc } = await openSession("detach");
      session.enter(doc("of:doc:x"), true);
      session.detachTracker();
      tracker.add(
        "space/space/of:doc:outside",
        { path: [], schema: true },
      );
      session.exit(doc("of:doc:x"), true, { ok: null });
      expect([...store.entries.values()][0].registrations).toEqual([]);
    });

    it("keys a frame to its identity when it consumed an unrecorded subtree", async () => {
      const { session, store, doc } = await openSession("dependency");
      session.enter(doc("of:doc:x"), true);
      // No entry exists for the consumed subtree, so the frame cannot be
      // shown identity-independent and narrows to its evaluating identity.
      session.dependency(doc("of:doc:unknown"), true);
      session.exit(doc("of:doc:x"), true, { ok: null });
      expect(store.entries.size).toBe(1);
      expect([...store.entries.keys()].every((key) => key.includes("|I[")))
        .toBe(true);
    });
  });
});

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { applyCommit, createBranch, open as openEngine } from "../v2/engine.ts";
import { getSlowQueries, Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  toDocumentPath,
  type TransactRequest,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-slow-query-test-audience";

const createServer = (store: string) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen() {
      return "did:key:z6Mk-memory-v2-slow-query-principal";
    },
    sessionOpenAuth: {
      audience: TEST_AUDIENCE,
    },
  });

const openSession = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
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
    requestId: "open",
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  const opened = messages.shift() as ResponseMessage<{ sessionId: string }>;
  expect(opened.ok).toBeDefined();
  return opened.ok!.sessionId;
};

describe("v2 server slow queries", () => {
  // The recording thresholds on real elapsed time, so the tests shift
  // `performance.now` from inside the measured window (the publishVerdict
  // callback runs between evaluation and the recording) instead of
  // sleeping. Restored after each test.
  const realNow = performance.now.bind(performance);
  let nowOffsetMs = 0;

  beforeEach(() => {
    nowOffsetMs = 0;
    performance.now = () => realNow() + nowOffsetMs;
  });

  afterEach(() => {
    performance.now = realNow;
  });

  const transactMessage = (
    space: string,
    sessionId: string,
    commit: TransactRequest["commit"],
  ): TransactRequest => ({
    type: "transact",
    requestId: crypto.randomUUID(),
    space,
    sessionId,
    commit,
  });

  it("records a slow applied commit with its lock wait and shape", async () => {
    const space = "did:key:z6Mk-slow-query-applied";
    const server = createServer("memory://slow-query-applied");
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    try {
      const sessionId = await openSession(connection, messages, space);

      const response = await server.transact(
        transactMessage(space, sessionId, {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:slow", value: { value: { n: 1 } } },
          ],
        }),
        () => {
          nowOffsetMs += 250;
        },
      );
      expect(response.error).toBeUndefined();

      const entry = getSlowQueries().find((slow) =>
        slow.space === space && slow.operation === "transact"
      );
      expect(entry).toBeDefined();
      expect(entry!.elapsed).toBeGreaterThanOrEqual(250);
      expect(entry!.outcome).toBe("ok");
      expect(entry!.operations).toBe(1);
      expect(entry!.readsConfirmed).toBe(0);
      expect(entry!.readsPending).toBe(0);
      expect(entry!.lockWaitMs).toBeGreaterThanOrEqual(0);
      expect(entry!.lockWaitMs!).toBeLessThan(entry!.elapsed);
    } finally {
      connection.close();
    }
  });

  it("records a commit whose wire shape lacks reads without masking the response", async () => {
    const space = "did:key:z6Mk-slow-query-malformed";
    const server = createServer("memory://slow-query-malformed");
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    try {
      const sessionId = await openSession(connection, messages, space);

      // The wire parser validates only the commit's envelope, so a commit
      // without `reads` reaches transact. Whatever the evaluation decides,
      // the recording must not replace that outcome with its own throw.
      let settled: { error?: { name: string } } | undefined;
      let threw: unknown;
      try {
        settled = await server.transact(
          transactMessage(
            space,
            sessionId,
            {
              localSeq: 1,
              operations: [
                { op: "set", id: "of:doc:bare", value: { value: { n: 1 } } },
              ],
            } as unknown as TransactRequest["commit"],
          ),
          () => {
            nowOffsetMs += 250;
          },
        );
      } catch (error) {
        threw = error;
      }
      expect(threw instanceof TypeError).toBe(false);

      const entry = getSlowQueries().find((slow) =>
        slow.space === space && slow.operation === "transact"
      );
      expect(entry).toBeDefined();
      expect(entry!.operations).toBe(1);
      expect(entry!.readsConfirmed).toBeUndefined();
      expect(entry!.readsPending).toBeUndefined();
      expect(typeof entry!.outcome).toBe("string");
      if (settled !== undefined) {
        expect(entry!.outcome).toBe(settled.error?.name ?? "ok");
      } else {
        expect(entry!.outcome).toBe("threw");
      }
    } finally {
      connection.close();
    }
  });

  it("records a slow rejected commit under the error's name", async () => {
    const space = "did:key:z6Mk-slow-query-conflict";
    const server = createServer("memory://slow-query-conflict");
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    try {
      const sessionId = await openSession(connection, messages, space);

      const seed = await server.transact(
        transactMessage(space, sessionId, {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:doc:contested", value: { value: { n: 1 } } },
          ],
        }),
      );
      expect(seed.error).toBeUndefined();

      // A confirmed read at seq 0 of a document the space already holds is
      // deterministically stale — the production shape a slow rejected
      // commit records under.
      const rejected = await server.transact(
        transactMessage(space, sessionId, {
          localSeq: 2,
          reads: {
            confirmed: [
              {
                id: "of:doc:contested",
                path: toDocumentPath(["value"]),
                seq: 0,
              },
            ],
            pending: [],
          },
          operations: [
            { op: "set", id: "of:doc:contested", value: { value: { n: 2 } } },
          ],
        }),
        () => {
          nowOffsetMs += 250;
        },
      );
      expect(rejected.error?.name).toBe("ConflictError");

      const entry = getSlowQueries().find((slow) =>
        slow.space === space && slow.operation === "transact"
      );
      expect(entry).toBeDefined();
      expect(entry!.outcome).toBe("ConflictError");
      expect(entry!.operations).toBe(1);
      expect(entry!.readsConfirmed).toBe(1);
    } finally {
      connection.close();
    }
  });

  it("records the roots a slow watch.add visited and the costliest one", async () => {
    const space = "did:key:z6Mk-slow-query-watch-roots";
    const server = createServer("memory://slow-query-watch-roots");
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    try {
      const sessionId = await openSession(connection, messages, space);
      const seeded = await server.transact(
        transactMessage(space, sessionId, {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:watched:one", value: { value: { n: 1 } } },
            { op: "set", id: "of:watched:two", value: { value: { n: 2 } } },
          ],
        }),
      );
      expect(seeded.error).toBeUndefined();

      // Every clock read advances the clock, so the evaluation crosses the
      // recording threshold without sleeping and without racing real time.
      // WHICH root wins is pinned in v2-query.test.ts against a lever aimed
      // at one root; the question here is only whether the attribution
      // reaches the recorded entry.
      performance.now = () => {
        nowOffsetMs += 60;
        return realNow() + nowOffsetMs;
      };
      await connection.receive(encodeMemoryBoundary({
        type: "session.watch.add",
        requestId: "watch-roots",
        space,
        sessionId,
        watches: [{
          id: "watch-roots-id",
          kind: "graph",
          query: {
            roots: [
              { id: "of:watched:one", selector: { path: [], schema: true } },
              { id: "of:watched:two", selector: { path: [], schema: true } },
            ],
          },
        }],
      }));

      const entry = getSlowQueries().find((slow) =>
        slow.space === space && slow.operation === "session.watch.add"
      );
      expect(entry).toBeDefined();
      expect(entry!.watches).toBe(1);
      // The watch count is 1 while the roots it carries are 2 — the whole
      // reason the count cannot stand in for the cost.
      expect(entry!.rootsVisited).toBe(2);
      expect(entry!.rootsElapsedMs).toBeGreaterThan(0);
      expect(entry!.rootsElapsedMs).toBeLessThanOrEqual(entry!.elapsed);
      expect(entry!.managerReads).toBeGreaterThanOrEqual(2);
      expect(entry!.upserts).toBe(2);
      const slowest = entry!.slowestRoot;
      expect(slowest).toBeDefined();
      expect(["of:watched:one", "of:watched:two"]).toContain(slowest!.id);
      expect(slowest!.scope).toBe("space");
      expect(slowest!.path).toBe("");
      expect(slowest!.reads).toBeGreaterThan(0);
      expect(slowest!.walk.dagTraversals).toBeGreaterThan(0);
    } finally {
      connection.close();
    }
  });

  it("keeps the last hundred slow entries and drops the oldest", async () => {
    // The ring holds a hundred entries; the hundred-and-first push evicts
    // the oldest. Every clock read advances the clock, so each query is
    // slow without sleeping, and the ring already holds whatever earlier
    // tests recorded — hence the first query gets a space of its own, so
    // that its eviction is what the assertion sees.
    const server = createServer("memory://slow-query-ring");
    try {
      performance.now = () => {
        nowOffsetMs += 150;
        return realNow() + nowOffsetMs;
      };
      const query = (space: string) =>
        server.evaluateGraphQuery(space, {
          roots: [{ id: "of:doc:ring", selector: { path: [], schema: true } }],
        });
      const first = "did:key:z6Mk-slow-query-ring-first";
      const rest = "did:key:z6Mk-slow-query-ring-rest";
      await query(first);
      expect(getSlowQueries().some((slow) => slow.space === first)).toBe(true);
      for (let n = 0; n < 100; n++) await query(rest);
      const entries = getSlowQueries();
      expect(entries.length).toBe(100);
      expect(entries.some((slow) => slow.space === first)).toBe(false);
      expect(entries.filter((slow) => slow.space === rest).length).toBe(100);
    } finally {
      await server.close();
    }
  });

  it("sums the roots of every branch group a slow watch.set evaluated", async () => {
    const space = "did:key:z6Mk-slow-query-watch-set-groups";
    const server = createServer("memory://slow-query-watch-set-groups");
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    try {
      await openSession(connection, messages, space);
      // A second branch is what makes two groups, and no protocol message
      // creates one — hence the engine `evaluateWatchSet` accepts.
      const engine = await openEngine({
        url: new URL("memory:///slow-query-watch-set-groups-engine"),
      });
      createBranch(engine, "feature");
      applyCommit(engine, {
        sessionId: "session:grouped",
        principal: "did:key:z6Mk-memory-v2-slow-query-principal",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:grouped:one", value: { value: { n: 1 } } },
            { op: "set", id: "of:grouped:two", value: { value: { n: 2 } } },
          ],
        },
      });

      performance.now = () => {
        nowOffsetMs += 60;
        return realNow() + nowOffsetMs;
      };
      // Watches group by branch, so these are two evaluations in one
      // request. The attribution has to accumulate across them: a fold
      // that replaced instead of summing would report the last group's
      // single root rather than all three.
      await server.evaluateWatchSet(space, [
        {
          id: "grouped-default",
          kind: "graph",
          query: {
            roots: [
              { id: "of:grouped:one", selector: { path: [], schema: true } },
              { id: "of:grouped:two", selector: { path: [], schema: true } },
            ],
          },
        },
        {
          id: "grouped-other",
          kind: "graph",
          query: {
            branch: "feature",
            roots: [
              { id: "of:grouped:one", selector: { path: [], schema: true } },
            ],
          },
        },
      ], engine);

      const entry = getSlowQueries().find((slow) =>
        slow.space === space && slow.operation === "session.watch.set"
      );
      expect(entry).toBeDefined();
      expect(entry!.watches).toBe(2);
      expect(entry!.rootsVisited).toBe(3);
      expect(entry!.slowestRoot!.reads).toBeGreaterThan(0);
      expect(entry!.slowestRoot!.walk.dagTraversals).toBeGreaterThan(0);
    } finally {
      connection.close();
    }
  });
});

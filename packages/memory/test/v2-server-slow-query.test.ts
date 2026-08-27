import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
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
});

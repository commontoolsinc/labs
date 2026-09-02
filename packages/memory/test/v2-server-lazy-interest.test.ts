import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  toDirtyKey,
  type TransactRequest,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-lazy-interest-audience";

const link = (space: string, id: string) => ({
  "/": { "link@1": { id, path: [], space } },
});

describe("v2-server-lazy-interest", () => {
  let server: Server;
  let messages: ServerMessage[];
  let arrivals: Array<() => void>;
  let connection: ReturnType<Server["connect"]>;

  beforeEach(() => {
    server = new Server({
      store: new URL("memory://lazy-interest"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen() {
        return "did:key:z6Mk-memory-v2-lazy-interest-principal";
      },
      sessionOpenAuth: {
        audience: TEST_AUDIENCE,
      },
    });
    messages = [];
    arrivals = [];
    connection = server.connect((message) => {
      messages.push(message);
      for (const arrived of arrivals.splice(0)) arrived();
    });
  });

  afterEach(async () => {
    await server.close();
  });

  // Resolves on the next message AFTER the call, so a wait placed after a
  // transact observes that commit's push rather than an earlier frame.
  const nextMessage = (): Promise<void> =>
    new Promise((resolve) => {
      arrivals.push(resolve);
    });

  const openSession = async (space: string): Promise<string> => {
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

  it("drops a retired registration from the session's wake set", async () => {
    // Sol's server-level repro for the lazy-interest lifecycle: a watch
    // whose crossing registers a derived cell, the crossing's manifest
    // entry removed, the update received — the retired target must leave
    // `session.trackedIds`, or every later commit to the orphaned cell
    // keeps waking and refreshing the session.

    const space = "did:key:z6Mk-memory-v2-lazy-interest";
    const sessionId = await openSession(space);
    const seeded = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: "of:derived-cell",
            value: { value: { n: 1 } },
          },
          {
            op: "set",
            id: "of:crossing",
            value: {
              value: { name: "crossing" },
              internal: [{ link: link(space, "of:derived-cell") }],
            },
          },
          {
            op: "set",
            id: "of:root",
            value: { value: { child: link(space, "of:crossing") } },
          },
        ],
      }),
    );
    expect(seeded.error).toBeUndefined();

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "lazy-interest-watch",
        kind: "graph",
        query: {
          roots: [{
            id: "of:root",
            selector: {
              path: [],
              schema: {
                type: "object",
                properties: {
                  child: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          }],
        },
      }],
    }));

    const cellDirtyKey = toDirtyKey("of:derived-cell");
    // The crossing registered the cell: its key is wake interest.
    expect(server.sessionTracksAny(space, sessionId, new Set([cellDirtyKey])))
      .toBe(true);

    const arrived = nextMessage();
    const unhooked = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:crossing",
          value: { value: { name: "crossing, unhooked" }, internal: [] },
        }],
      }),
    );
    expect(unhooked.error).toBeUndefined();
    await arrived;

    // The re-walk released the registration, and the rebuild carried the
    // retirement into the wake set.
    expect(server.sessionTracksAny(space, sessionId, new Set([cellDirtyKey])))
      .toBe(false);

    // A later commit to the orphaned cell delivers nothing to this
    // session: the frames that follow it never carry the cell. The marker
    // commit's own frame bounds the wait.
    const framesBefore = messages.length;
    const orphanTouched = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 3,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:derived-cell",
          value: { value: { n: 2 } },
        }],
      }),
    );
    expect(orphanTouched.error).toBeUndefined();
    const markerArrived = nextMessage();
    const marker = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:root",
          value: {
            value: { child: link(space, "of:crossing"), marker: true },
          },
        }],
      }),
    );
    expect(marker.error).toBeUndefined();
    await markerArrived;
    const framesSince = JSON.stringify(messages.slice(framesBefore));
    expect(framesSince.includes("of:derived-cell")).toBe(false);
  });

  it("notifies demand when a rewrite swaps one lazy target for another", async () => {
    // Sol's A→B repro: the wake set is rebuilt on refresh, so rewriting a
    // crossing's manifest from lazy target A to B replaces one tracked id
    // with another at the same cardinality. The demand pass must hear about
    // the swap — a size-growth check stays silent on it, and server
    // execution would keep the old demand registry and never activate B.

    const space = "did:key:z6Mk-memory-v2-lazy-swap";
    const sessionId = await openSession(space);
    const seeded = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:lazy-a", value: { value: { n: 1 } } },
          { op: "set", id: "of:lazy-b", value: { value: { n: 1 } } },
          {
            op: "set",
            id: "of:crossing",
            value: {
              value: { name: "crossing" },
              internal: [{ link: link(space, "of:lazy-a") }],
            },
          },
          {
            op: "set",
            id: "of:root",
            value: { value: { child: link(space, "of:crossing") } },
          },
        ],
      }),
    );
    expect(seeded.error).toBeUndefined();

    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.add",
      requestId: "watch",
      space,
      sessionId,
      watches: [{
        id: "lazy-swap-watch",
        kind: "graph",
        query: {
          roots: [{
            id: "of:root",
            selector: {
              path: [],
              schema: {
                type: "object",
                properties: {
                  child: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          }],
        },
      }],
    }));

    const aKey = toDirtyKey("of:lazy-a");
    const bKey = toDirtyKey("of:lazy-b");
    expect(server.sessionTracksAny(space, sessionId, new Set([aKey])))
      .toBe(true);
    expect(server.sessionTracksAny(space, sessionId, new Set([bKey])))
      .toBe(false);

    // Attached after the watch, so the captures below are the swap's own.
    const reasons: (string | undefined)[] = [];
    server.setServerExecutionObserver({
      demandChanged: (_space, reason) => {
        reasons.push(reason);
      },
    });

    const arrived = nextMessage();
    const swapped = await server.transact(
      transactMessage(space, sessionId, {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:crossing",
          value: {
            value: { name: "crossing" },
            internal: [{ link: link(space, "of:lazy-b") }],
          },
        }],
      }),
    );
    expect(swapped.error).toBeUndefined();
    await arrived;

    // The membership swapped at unchanged cardinality...
    expect(server.sessionTracksAny(space, sessionId, new Set([aKey])))
      .toBe(false);
    expect(server.sessionTracksAny(space, sessionId, new Set([bKey])))
      .toBe(true);
    // ...and the swap still reached the demand pass.
    expect(reasons).toContain("push-growth");
  });
});

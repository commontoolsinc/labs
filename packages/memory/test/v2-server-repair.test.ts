import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { FabricValue } from "@commonfabric/data-model";

import {
  type ClientCommit,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionSync,
  toDocumentPath,
} from "../v2.ts";
import { RepairCoverage } from "../v2/repair-coverage.ts";
import { parseClientMessage, Server, SessionRegistry } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:repair-server-space";
const SESSION = "repair-session";

function staleCommit(localSeq: number): ClientCommit {
  return {
    localSeq,
    reads: {
      confirmed: [{
        id: "of:output",
        scope: "user",
        path: toDocumentPath(["value"]),
        seq: 0,
      }],
      pending: [],
    },
    operations: [
      { op: "set", id: "of:output", scope: "user", value: { value: null } },
      {
        op: "set",
        id: "of:output",
        value: {
          value: {
            "/": { "link@1": { id: "of:output", scope: "user", path: [] } },
          },
        },
      },
    ],
  };
}

describe("server transaction repair delivery", () => {
  let time: FakeTime;
  let server: Server;
  let sessions: SessionRegistry;
  let connection: ReturnType<Server["connect"]>;
  let messages: ServerMessage[];
  let failNextEffect: boolean;

  beforeEach(async () => {
    time = new FakeTime();
    sessions = new SessionRegistry();
    server = new Server({
      store: new URL("memory://server-repair"),
      sessions,
      subscriptionRefreshDelayMs: 100,
      ...testSessionOpenServerOptions,
    });
    messages = [];
    failNextEffect = false;
    connection = server.connect((message) => {
      if (failNextEffect && message.type === "session/effect") {
        failNextEffect = false;
        throw new Error("test transport refused the frame");
      }
      messages.push(message);
    });
    await send({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    });
    const hello = messages.shift();
    if (hello?.type !== "hello.ok" || hello.sessionOpen === undefined) {
      throw new Error("Expected hello.ok");
    }
    await send({
      type: "session.open",
      requestId: "open",
      space: SPACE,
      session: { sessionId: SESSION },
      invocation: {
        aud: hello.sessionOpen.audience,
        challenge: hello.sessionOpen.challenge.value,
      },
    });
    expect(response().error).toBeUndefined();
    await transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:output", scope: "user", value: { value: null } },
        {
          op: "set",
          id: "of:output",
          value: {
            value: { "/": { "link@1": { id: "of:alternate", path: [] } } },
          },
        },
        { op: "set", id: "of:alternate", value: { value: "alternate value" } },
      ],
    });
    expect(response().error).toBeUndefined();
    await server.flushSessions([SPACE]);
    effect();
    expect(messages).toEqual([]);
  });

  afterEach(async () => {
    await server.close();
    time.restore();
  });

  async function send(value: FabricValue): Promise<void> {
    await connection.receive(encodeMemoryBoundary(value));
  }

  async function transact(commit: ClientCommit): Promise<void> {
    await send({
      type: "transact",
      requestId: `tx-${commit.localSeq}`,
      space: SPACE,
      sessionId: SESSION,
      commit,
    });
  }

  function response(): ResponseMessage<unknown> {
    const message = messages.shift();
    if (message?.type !== "response") throw new Error("Expected response");
    return message;
  }

  function effect(): SessionSync {
    const message = messages.shift();
    if (message?.type !== "session/effect") {
      throw new Error("Expected session effect");
    }
    return message.effect;
  }

  function enableCoverage(): RepairCoverage {
    const session = sessions.get(SPACE, SESSION);
    if (session === null) throw new Error("Expected an open session");
    // Session admission does not negotiate repairs yet. Install the component
    // through the registry to exercise its actual server/transport integration.
    session.repairs = new RepairCoverage(SPACE, {
      principal: TEST_SESSION_OPEN_PRINCIPAL,
      sessionId: SESSION,
    });
    return session.repairs;
  }

  async function release(ids: number[]): Promise<void> {
    await send({
      type: "session.ack",
      requestId: "release",
      space: SPACE,
      sessionId: SESSION,
      seenSeq: 0,
      releaseRepairs: ids,
    });
    expect(response().error).toBeUndefined();
  }

  it("delivers the unwatched scoped basis after the conflict and permits a fresh retry", async () => {
    const coverage = enableCoverage();
    await transact(staleCommit(2));
    const rejected = response();
    expect(rejected.error?.name).toBe("ConflictError");
    expect(rejected.error?.repair).toEqual({ localSeq: 2 });
    expect(messages).toEqual([]);
    await server.flushSessions([SPACE]);
    const repaired = effect();
    expect(repaired.caughtUpLocalSeq).toBe(2);
    expect(repaired.repairs?.[0].atSeq).toBe(rejected.error?.retryAfterSeq);
    expect(repaired.upserts.map((doc) => [doc.id, doc.scope])).toEqual([[
      "of:output",
      "space",
    ], ["of:output", "user"]]);
    expect(sessions.get(SPACE, SESSION)?.entities.size).toBe(0);
    expect(server.demandedInstancesForSpace(SPACE)).toEqual([]);
    const retry = staleCommit(3);
    const basis = repaired.repairs?.[0].documents.find((doc) =>
      doc.scope === "user"
    );
    expect(basis).toBeDefined();
    retry.reads.confirmed[0].seq = basis!.seq;
    await transact(retry);
    expect(response().error).toBeUndefined();
    await server.flushSessions([SPACE]);
    effect();
    await release([2]);
    await server.accessForTestingOnly.flushScheduledSessions();
    expect(effect().removes.map((doc) => [doc.id, doc.scope])).toEqual([[
      "of:output",
      "space",
    ], ["of:output", "user"]]);
    expect(coverage.size).toBe(0);
    expect(server.demandedInstancesForSpace(SPACE)).toEqual([]);
  });

  it("answers changed dependencies under one rejection identity with a protocol error", async () => {
    const coverage = enableCoverage();
    await transact(staleCommit(2));
    expect(response().error?.name).toBe("ConflictError");
    const changed = staleCommit(2);
    changed.reads.confirmed.push({
      id: "of:alternate",
      path: toDocumentPath([]),
      seq: 0,
    });
    await transact(changed);
    expect(response().error?.name).toBe("ProtocolError");
    expect(coverage.size).toBe(1);
  });

  it("leaves ordinary sessions on the inactive protocol path", async () => {
    await transact(staleCommit(2));
    expect(response().error?.repair).toBeUndefined();
    await server.flushSessions([SPACE]);
    const sync = effect();
    expect(sync.repairs).toBeUndefined();
    expect(sync.upserts).toEqual([]);
    expect(sessions.get(SPACE, SESSION)?.repairs).toBeUndefined();
    await send({
      type: "session.ack",
      requestId: "release",
      space: SPACE,
      sessionId: SESSION,
      seenSeq: 0,
      releaseRepairs: [2],
    });
    expect(response().error?.name).toBe("ProtocolError");
  });

  it("keeps repair coverage through full watch replacement and removal", async () => {
    const coverage = enableCoverage();
    await transact(staleCommit(2));
    response();
    await server.flushSessions([SPACE]);
    effect();
    await send({
      type: "session.watch.set",
      requestId: "watch",
      space: SPACE,
      sessionId: SESSION,
      watches: [{
        id: "output",
        kind: "graph",
        query: {
          roots: [{ id: "of:output", selector: { path: [], schema: false } }],
        },
      }],
    });
    expect(response().error).toBeUndefined();
    await send({
      type: "session.watch.set",
      requestId: "unwatch",
      space: SPACE,
      sessionId: SESSION,
      watches: [],
    });
    const removed = response().ok as { sync: SessionSync };
    expect(removed.sync.removes.some((doc) => doc.id === "of:output")).toBe(
      false,
    );
    expect(coverage.size).toBe(1);
    expect(server.demandedInstancesForSpace(SPACE)).toEqual([]);
    await release([2]);
    await server.accessForTestingOnly.flushScheduledSessions();
    expect(effect().removes).toHaveLength(2);
  });

  it("redelivers complete repair after a failed send without adding graph demand", async () => {
    const coverage = enableCoverage();
    await transact(staleCommit(2));
    response();
    failNextEffect = true;
    await server.flushSessions([SPACE]);
    expect(messages).toEqual([]);
    expect(coverage.needsSync(new Set())).toBe(true);
    expect(sessions.get(SPACE, SESSION)?.entities.size).toBe(0);
    await server.accessForTestingOnly.flushScheduledSessions();
    const retried = effect();
    expect(retried.repairs?.[0].localSeq).toBe(2);
    expect(retried.upserts).toHaveLength(2);
    expect(server.demandedInstancesForSpace(SPACE)).toEqual([]);
  });

  it("updates a retained repair document during an otherwise untouched graph pass", async () => {
    enableCoverage();
    await transact(staleCommit(2));
    response();
    await server.flushSessions([SPACE]);
    effect();
    await transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:output",
        scope: "user",
        value: { value: "changed" },
      }],
    });
    expect(response().error).toBeUndefined();
    await server.flushSessions([SPACE]);
    const sync = effect();
    expect(sync.upserts).toHaveLength(1);
    expect(sync.upserts[0].doc).toEqual({ value: "changed" });
    expect(sync.repairs).toBeUndefined();
    expect(server.demandedInstancesForSpace(SPACE)).toEqual([]);
  });

  it("releases shared coverage only after its final owner finishes", async () => {
    const coverage = enableCoverage();
    await transact(staleCommit(2));
    response();
    await transact(staleCommit(3));
    response();
    await server.flushSessions([SPACE]);
    const sync = effect();
    expect(sync.repairs?.map((receipt) => receipt.localSeq)).toEqual([2, 3]);
    expect(sync.upserts).toHaveLength(2);
    await release([3]);
    await server.accessForTestingOnly.flushScheduledSessions();
    expect(messages).toEqual([]);
    expect(coverage.size).toBe(1);
    await release([2]);
    await server.accessForTestingOnly.flushScheduledSessions();
    expect(effect().removes).toHaveLength(2);
    expect(coverage.size).toBe(0);
  });

  it("validates explicit release identities at the wire boundary", () => {
    const ack = {
      type: "session.ack",
      requestId: "release",
      space: SPACE,
      sessionId: SESSION,
      seenSeq: 0,
    };
    expect(
      parseClientMessage(
        encodeMemoryBoundary({ ...ack, releaseRepairs: [3, 1] }),
      ),
    ).toEqual({
      ...ack,
      releaseRepairs: [3, 1],
    });
    for (const invalid of [[-1], [0.5], ["3"], null, 1]) {
      expect(
        parseClientMessage(
          encodeMemoryBoundary({ ...ack, releaseRepairs: invalid }),
        ),
      )
        .toBeNull();
    }
  });
});

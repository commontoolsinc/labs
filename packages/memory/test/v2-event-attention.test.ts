import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  eventAttentionIndexKey,
  type EventAttentionIndexValue,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  type ResponseMessage,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventsDocValue,
  type StreamLinkRef,
} from "../v2.ts";

const AUDIENCE = "did:key:z6Mk-event-attention-audience";
const SPACE = "did:key:z6Mk-event-attention-space";
const ALICE = "did:key:z6Mk-event-attention-alice";
const BOB = "did:key:z6Mk-event-attention-bob";
const STREAM = { id: "of:event-attention-result", path: ["submit"] };
const SIDECAR = streamEntriesDocId(STREAM);
const SECOND_STREAM = { id: "of:event-attention-result", path: ["approve"] };
const SECOND_SIDECAR = streamEntriesDocId(SECOND_STREAM);

type Connection = ReturnType<Server["connect"]>;

describe("event attention resolution", () => {
  let server: Server;
  const connections: Connection[] = [];
  let nextSeedLocalSeq = 100;

  beforeEach(() => {
    setServerExecutionConfig(true);
    server = new Server({
      store: new URL(`memory://event-attention-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const issuer = message.invocation?.iss;
        return typeof issuer === "string" ? issuer : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
    });
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await server.close();
    resetServerExecutionConfig();
  });

  const openSession = async (principal: string): Promise<string> => {
    const messages: unknown[] = [];
    const connection = server.connect((message) => messages.push(message));
    connections.push(connection);
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages.shift() as HelloOkMessage;
    expect(hello.type).toBe("hello.ok");
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: crypto.randomUUID(),
      space: SPACE,
      session: {},
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    const response = messages.shift() as ResponseMessage<{
      sessionId: string;
    }>;
    expect(response.error).toBeUndefined();
    return response.ok!.sessionId;
  };

  const seedAttention = async (
    sessionId: string,
    principal: string,
    eventId: string,
    stream: StreamLinkRef = STREAM,
  ): Promise<void> => {
    const engine = await server.engineForSpace(SPACE);
    const sidecarId = streamEntriesDocId(stream);
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId,
      principal,
      commitClass: "authored",
      commit: {
        localSeq: nextSeedLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecarId,
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [{
              eventId,
              stream,
              payload: { answer: "captured", nested: [1, 2] },
              runtimeInjectedEventKeys: ["detail"],
              rendererTrusted: true,
            }],
          }],
        }],
        eventAppends: [{ id: sidecarId, eventId }],
      },
    });
    const value = Engine.read(engine, { id: sidecarId })!
      .value as StreamEventsDocValue;
    const entry = value.entries!.find((candidate) =>
      candidate.eventId === eventId
    )!;
    const attention = {
      phase: "dispatch-load" as const,
      failureClass: "session-revoked" as const,
      code: "permanent-delivery-failure" as const,
      firstFailureAt: 10,
      lastFailureAt: 10,
      accumulatedFailureMs: 0,
      failureCount: 1,
      recovery: "explicit-retry" as const,
    };
    const currentIndex = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue | undefined;
    const sidecarKey = eventAttentionIndexKey(sidecarId);
    const eventKey = eventAttentionIndexKey(eventId);
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId,
      principal,
      commitClass: "system",
      commit: {
        localSeq: nextSeedLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecarId,
          patches: [
            {
              op: "add",
              path: `/value/entries/${
                value.entries!.indexOf(entry)
              }/consequenced`,
              value: true,
            },
            {
              op: "add",
              path: `/value/entries/${value.entries!.indexOf(entry)}/status`,
              value: "needs-attention",
            },
            {
              op: "add",
              path: `/value/entries/${value.entries!.indexOf(entry)}/reason`,
              value: "This event could not be delivered.",
            },
            {
              op: "add",
              path: `/value/entries/${value.entries!.indexOf(entry)}/attention`,
              value: attention,
            },
          ],
        }, {
          op: "set",
          id: SERVER_EXECUTION_ATTENTION_DOC_ID,
          value: {
            value: {
              entries: {
                ...(currentIndex?.entries ?? {}),
                [sidecarKey]: {
                  ...(currentIndex?.entries?.[sidecarKey] ?? {}),
                  [eventKey]: {
                    eventId,
                    sidecarId,
                    phase: attention.phase,
                    failureClass: attention.failureClass,
                    code: attention.code,
                    firstFailureAt: attention.firstFailureAt,
                  },
                },
              },
            },
          },
        }],
      },
    });
  };

  it("Retry atomically resolves the original and appends one exact-provenance successor", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "evt-original");

    const first = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "retry-1",
      space: SPACE,
      sessionId,
      eventId: "evt-original",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(first.error).toBeUndefined();
    expect(first.ok!.resolution.kind).toBe("retried");
    const retryId = (first.ok!.resolution as {
      kind: "retried";
      eventId: string;
    }).eventId;

    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(entries).toHaveLength(2);
    const original = entries.find((entry) => entry.eventId === "evt-original")!;
    const retry = entries.find((entry) => entry.eventId === retryId)!;
    expect(original.resolution).toEqual({ kind: "retried", eventId: retryId });
    expect(retry.payload).toEqual(original.payload);
    expect(retry.runtimeInjectedEventKeys).toEqual(
      original.runtimeInjectedEventKeys,
    );
    expect(retry.rendererTrusted).toBe(true);
    expect(retry.retryOf).toBe(original.eventId);
    expect(retry.firedAt).toEqual({ user: ALICE, session: sessionId });
    expect(retry.seq).toBeGreaterThan(original.seq!);
    expect(
      Engine.read(engine, { id: SERVER_EXECUTION_ATTENTION_DOC_ID })?.value,
    ).toEqual({ entries: {} });

    const replay = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "retry-lost-response",
      space: SPACE,
      sessionId,
      eventId: "evt-original",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(replay.ok!.resolution).toEqual(first.ok!.resolution);
    expect(
      (Engine.read(engine, { id: SIDECAR })!.value as StreamEventsDocValue)
        .entries,
    ).toHaveLength(2);

    const bobSession = await openSession(BOB);
    const crossUserReplay = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "retry-cross-user-replay",
      space: SPACE,
      sessionId: bobSession,
      eventId: "evt-original",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(crossUserReplay.error?.name).toBe("AuthorizationError");
  });

  it("Dismiss records resolution without an append", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "evt-dismiss");
    const response = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "dismiss",
      space: SPACE,
      sessionId,
      eventId: "evt-dismiss",
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(response.ok!.resolution).toEqual({ kind: "dismissed" });
    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(entries).toHaveLength(1);
    expect(entries[0].resolution).toEqual({ kind: "dismissed" });
  });

  it("overlapping Retry and Dismiss requests return one recorded resolution", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "evt-retry-race");
    const retryRequest = {
      type: "event.attention.resolve" as const,
      space: SPACE,
      sessionId,
      eventId: "evt-retry-race",
      sidecarId: SIDECAR,
      action: "retry" as const,
    };
    const [retryA, retryB] = await Promise.all([
      server.resolveEventAttention({
        ...retryRequest,
        requestId: "retry-race-a",
      }),
      server.resolveEventAttention({
        ...retryRequest,
        requestId: "retry-race-b",
      }),
    ]);
    expect(retryA.error).toBeUndefined();
    expect(retryB.error).toBeUndefined();
    expect(retryA.ok!.resolution).toEqual(retryB.ok!.resolution);
    const raceEngine = await server.engineForSpace(SPACE);
    const retryRaceEntries = (Engine.read(raceEngine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(
      retryRaceEntries.filter((entry) => entry.retryOf === "evt-retry-race"),
    ).toHaveLength(1);

    await seedAttention(sessionId, ALICE, "evt-race");
    const request = {
      type: "event.attention.resolve" as const,
      space: SPACE,
      sessionId,
      eventId: "evt-race",
      sidecarId: SIDECAR,
    };
    const [retry, dismiss] = await Promise.all([
      server.resolveEventAttention({
        ...request,
        requestId: "race-retry",
        action: "retry",
      }),
      server.resolveEventAttention({
        ...request,
        requestId: "race-dismiss",
        action: "dismiss",
      }),
    ]);

    expect(retry.error).toBeUndefined();
    expect(dismiss.error).toBeUndefined();
    expect(retry.ok!.resolution).toEqual(dismiss.ok!.resolution);

    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    const original = entries.find((entry) => entry.eventId === "evt-race")!;
    expect(original.resolution).toEqual(retry.ok!.resolution);
    const retryEntries = entries.filter((entry) =>
      entry.retryOf === original.eventId
    );
    expect(retryEntries.length).toBe(
      original.resolution?.kind === "retried" ? 1 : 0,
    );
    expect(
      Engine.read(engine, { id: SERVER_EXECUTION_ATTENTION_DOC_ID })?.value,
    ).toEqual({ entries: {} });
  });

  it("keeps equal event IDs from different streams independently resolvable", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "evt-shared");
    await seedAttention(sessionId, ALICE, "evt-shared", SECOND_STREAM);

    const engine = await server.engineForSpace(SPACE);
    const before = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    const sharedEventKey = eventAttentionIndexKey("evt-shared");
    expect(
      before.entries?.[eventAttentionIndexKey(SIDECAR)]?.[sharedEventKey]
        ?.sidecarId,
    ).toBe(SIDECAR);
    expect(
      before.entries?.[eventAttentionIndexKey(SECOND_SIDECAR)]?.[sharedEventKey]
        ?.sidecarId,
    ).toBe(SECOND_SIDECAR);

    const first = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "same-id-first",
      space: SPACE,
      sessionId,
      eventId: "evt-shared",
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(first.error).toBeUndefined();
    const afterFirst = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    expect(
      afterFirst.entries?.[eventAttentionIndexKey(SIDECAR)],
    ).toBeUndefined();
    expect(
      afterFirst.entries?.[eventAttentionIndexKey(SECOND_SIDECAR)]?.[
        sharedEventKey
      ]?.sidecarId,
    ).toBe(SECOND_SIDECAR);

    const second = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "same-id-second",
      space: SPACE,
      sessionId,
      eventId: "evt-shared",
      sidecarId: SECOND_SIDECAR,
      action: "dismiss",
    });
    expect(second.error).toBeUndefined();
    expect(
      Engine.read(engine, { id: SERVER_EXECUTION_ATTENTION_DOC_ID })?.value,
    ).toEqual({ entries: {} });
  });

  it("resolves an event whose identifier names an object prototype key", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "__proto__");

    const response = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "prototype-key",
      space: SPACE,
      sessionId,
      eventId: "__proto__",
      sidecarId: SIDECAR,
      action: "dismiss",
    });

    expect(response.error).toBeUndefined();
    const engine = await server.engineForSpace(SPACE);
    expect(
      Engine.read(engine, { id: SERVER_EXECUTION_ATTENTION_DOC_ID })?.value,
    ).toEqual({ entries: {} });
  });

  it("resolution is restricted to the original acting user and a live session", async () => {
    const aliceSession = await openSession(ALICE);
    const bobSession = await openSession(BOB);
    await seedAttention(aliceSession, ALICE, "evt-owned");

    const crossUser = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "cross-user",
      space: SPACE,
      sessionId: bobSession,
      eventId: "evt-owned",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(crossUser.error?.name).toBe("AuthorizationError");

    const sessionless = await server.resolveEventAttention({
      type: "event.attention.resolve",
      requestId: "sessionless",
      space: SPACE,
      sessionId: "missing-session",
      eventId: "evt-owned",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(sessionless.error?.name).toBe("SessionError");
    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(entries).toHaveLength(1);
    expect(entries[0].resolution).toBeUndefined();
  });
});

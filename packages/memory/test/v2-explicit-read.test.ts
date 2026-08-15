// Server-execution v2 stage F: the read-side admission row (protocol.md
// §2's READ row; the read half of §1's transaction identity model, ledger
// LD5). A read naming an explicit `entity_scope_key` is admissible only
// for a live lease holder on the co-hosted memory server — the operand
// mapping is the session's authenticated principal equaling the
// SERVICE-IDENTITY component of the space's live DR1 holder. A non-holder
// naming a key is REJECTED (before stage F the wire could not even
// express one); a read naming none resolves from the session as today.

import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type GraphQueryResult,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  resolveScopeKey,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  setServerExecutionConfig,
  type WatchSetResult,
} from "../v2.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
  releaseExecutionLease,
} from "../v2/execution-lease.ts";

const TEST_AUDIENCE = "did:key:z6Mk-explicit-read-audience";
const SPACE = "did:key:z6Mk-explicit-read-space";
const SERVICE = "did:key:z6Mk-explicit-read-service";
const ALICE = "did:key:z6Mk-explicit-read-alice";
const BOB = "did:key:z6Mk-explicit-read-bob";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen! };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

const openSession = async (
  harness: Harness,
  principal: string,
  session: { sessionId?: string; sessionToken?: string } = {},
): Promise<{ sessionId: string; sessionToken: string; sync?: unknown }> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space: SPACE,
    session,
    invocation: {
      iss: principal,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const response = shiftMessage(harness.messages) as ResponseMessage<
    {
      sessionId: string;
      sessionToken: string;
      sessionOpen: SessionOpenAuthMetadata;
      sync?: unknown;
    }
  >;
  assertExists(response.ok, JSON.stringify(response.error));
  harness.sessionOpen = response.ok.sessionOpen;
  return {
    sessionId: response.ok.sessionId,
    sessionToken: response.ok.sessionToken,
    ...(response.ok.sync === undefined ? {} : { sync: response.ok.sync }),
  };
};

const newServer = (store: string): Server =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
  });

Deno.test("explicit entity_scope_key reads: lease holder admitted, non-holder and off-flag refused (protocol.md §2's read row)", async () => {
  const server = newServer("memory://explicit-read");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);

    // Alice writes her own user-scoped instance — the doc under
    // `user:<alice>` that only the read row lets another party name.
    const write = await server.transact({
      type: "transact",
      requestId: nextRequestId("write"),
      space: SPACE,
      sessionId: aliceSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:profile",
          scope: "user",
          value: { value: { name: "alice" } },
        }],
      },
    });
    assertExists(write.ok);
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // The SpaceServer's loopback session: principal = the service
    // identity the DR1 holder was minted from, holding the live lease.
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(acquireExecutionLease(engine, { space: SPACE, holder }), true);

    // The holder names alice's instance explicitly and reads it.
    const held = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("held"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(held.ok, JSON.stringify(held.error));
    assertEquals(held.ok.entities.length, 1);
    assertEquals(held.ok.entities[0].document?.value, { name: "alice" });

    // A non-holder (bob's ordinary client session) naming a key is
    // REJECTED — the wire field exists now, so the refusal must too.
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("refused"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(refused.ok, undefined);
    assertEquals(refused.error?.name, "ProtocolError");
    assertEquals(
      refused.error?.message.includes("does not hold a live execution_lease"),
      true,
    );

    // The watch path refuses identically.
    const refusedWatch = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("refused-watch"),
      space: SPACE,
      sessionId: bobSession,
      watches: [{
        id: "w1",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertEquals(refusedWatch.error?.name, "ProtocolError");

    // Bob's key-less read still resolves from his own session (empty —
    // his instance holds nothing), unchanged from today.
    const bobOwn = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("bob-own"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    }) as ResponseMessage<GraphQueryResult>;
    assertExists(bobOwn.ok);
    assertEquals(bobOwn.ok.entities[0]?.document ?? null, null);

    // The watch.ADD path refuses identically (the third admission
    // site).
    const refusedWatchAdd = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("refused-watch-add"),
      space: SPACE,
      sessionId: bobSession,
      watches: [{
        id: "w2",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    });
    assertEquals(refusedWatchAdd.error?.name, "ProtocolError");

    // An EXPIRED lease matches nobody: the same holder session is
    // refused once the row lapses (liveness judged by the server's own
    // clock — serving-loop.md §2).
    releaseExecutionLease(engine, { space: SPACE, holder });
    assertEquals(
      acquireExecutionLease(engine, {
        space: SPACE,
        holder,
        now: Date.now() - 60_000,
        ttlMs: 1,
      }),
      true,
    );
    const expired = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("expired"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(expired.error?.name, "ProtocolError");
    assertEquals(
      expired.error?.message.includes("does not hold a live execution_lease"),
      true,
    );
    // Restore the live lease for the off-flag case below.
    assertEquals(acquireExecutionLease(engine, { space: SPACE, holder }), true);

    // Off the flag the field is unclaimable, holder or not.
    resetServerExecutionConfig();
    const offFlag = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("off-flag"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(offFlag.error?.name, "ProtocolError");
    assertEquals(
      offFlag.error?.message.includes("EXPERIMENTAL_SERVER_EXECUTION"),
      true,
    );
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// The exemption LIFECYCLE (stage-F fix round, thread r3731191378 — P0):
// `leaseHolderReads` is an authorization exemption tied to holding a LIVE
// execution lease. The push path's applicable-set filter (protocol.md §3)
// must key its bypass on CURRENT holdership, lease loss must clear the
// exemption, and a session resume must revalidate rather than trust the
// persisted bit. A former holder receives NOTHING foreign.
// ---------------------------------------------------------------------------

/** Doc-ids upserted by session/effect frames at or past `from`. */
const effectUpsertIds = (
  messages: ServerMessage[],
  from: number,
): string[] => {
  const ids: string[] = [];
  for (const message of messages.slice(from)) {
    if ((message as { type?: string }).type !== "session/effect") continue;
    const effect = (message as {
      effect?: { upserts?: Array<{ id: string }> };
    }).effect;
    for (const upsert of effect?.upserts ?? []) ids.push(upsert.id);
  }
  return ids;
};

/** Drive delivery deterministically: each idle() drains the pending
 * refresh pass (which may requeue once internally — hence the bounded
 * loop, macrotask-yielding so a deferred requeue can arm before the next
 * drain). Iteration-bounded, never wall-clock-bounded, so machine load
 * cannot flake it. */
const drainDelivery = async (
  server: Server,
  done: () => boolean,
): Promise<void> => {
  for (let pass = 0; pass < 50; pass++) {
    if (done()) return;
    await server.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const expireLease = (
  engine: Awaited<ReturnType<Server["engineForSpace"]>>,
  holder: string,
): void => {
  releaseExecutionLease(engine, { space: SPACE, holder });
  // Leave an EXPIRED row: liveness is judged by expiry, and an expired
  // row must match nobody (serving-loop.md §2).
  assertEquals(
    acquireExecutionLease(engine, {
      space: SPACE,
      holder,
      now: Date.now() - 60_000,
      ttlMs: 1,
    }),
    true,
  );
};

const watchAliceInstance = (
  sessionId: string,
  aliceKey: string,
  watchId = "w-foreign",
) => ({
  type: "session.watch.set" as const,
  requestId: nextRequestId("watch"),
  space: SPACE,
  sessionId,
  watches: [{
    id: watchId,
    kind: "graph" as const,
    query: {
      roots: [{
        id: "of:profile",
        scope: "user" as const,
        entityScopeKey: aliceKey as never,
        selector: { path: [], schema: false as const },
      }],
    },
  }],
});

const writeAliceProfile = async (
  server: Server,
  aliceSession: string,
  localSeq: number,
  value: Record<string, string>,
): Promise<void> => {
  const write = await server.transact({
    type: "transact",
    requestId: nextRequestId("write"),
    space: SPACE,
    sessionId: aliceSession,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:profile",
        scope: "user",
        value: { value },
      }],
    },
  });
  assertExists(write.ok, JSON.stringify(write.error));
};

Deno.test("lease-holder push exemption dies with the lease: a former holder receives no foreign scoped instances (P0)", async () => {
  const server = newServer("memory://explicit-read-former-holder");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );

    // Holder admitted: the watch response carries alice's instance.
    const watch = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));
    assertEquals(
      watch.ok.sync.upserts.map((upsert) => upsert.id),
      ["of:profile"],
    );

    // While the lease is LIVE, pushes deliver the foreign instance.
    const liveFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(
      server,
      () => effectUpsertIds(service.messages, liveFrom).includes("of:profile"),
    );
    assertEquals(
      effectUpsertIds(service.messages, liveFrom).includes("of:profile"),
      true,
      "a LIVE holder receives the foreign instance's refresh frame",
    );

    // The lease lapses. The cached exemption must die with it: the next
    // foreign-instance write is ABSENT from the former holder's frames.
    expireLease(engine, holder);
    const lapsedFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 3, { name: "alice-3" });
    // Drain until alice's own watcher-free delivery settles: bound the
    // drain by the server going quiet rather than by seeing a frame.
    await drainDelivery(server, () => false);
    assertEquals(
      effectUpsertIds(service.messages, lapsedFrom).filter(
        (id) => id === "of:profile",
      ),
      [],
      "a FORMER holder must not receive foreign scoped instances " +
        "(protocol.md §2's read row is live-lease admission; §3's filter " +
        "applies once the lease is gone)",
    );

    // Recovery is re-admission, not the stale bit: re-acquire the lease
    // and RE-ISSUE the explicit watch — delivery resumes with current
    // state, including the update the filter withheld above.
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const rewatch = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(rewatch.ok, JSON.stringify(rewatch.error));
    const rewatchDocs = rewatch.ok.sync.upserts.filter(
      (upsert) => upsert.id === "of:profile",
    );
    assertEquals(rewatchDocs.length, 1);
    assertEquals(
      (rewatchDocs[0] as { doc?: { value?: unknown } }).doc?.value,
      { name: "alice-3" },
      "re-admission redelivers the update the filter withheld " +
        "(a filtered entry must never be cached as already-delivered)",
    );

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("the persisted lease-holder exemption does not survive session resume without a live lease", async () => {
  const server = newServer("memory://explicit-read-resume");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const service = await connect(server);
    const opened = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const watch = await server.watchSet(
      watchAliceInstance(opened.sessionId, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));

    // Connection dies; the lease lapses while the session is detached.
    service.connection.close();
    expireLease(engine, holder);

    // Foreign state moves while detached.
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });
    await drainDelivery(server, () => false);

    // Resume. The persisted `leaseHolderReads` bit must be revalidated
    // against the (dead) lease: neither the resume catch-up nor any
    // later push may deliver the foreign instance.
    const resumedHarness = await connect(server);
    const resumed = await openSession(resumedHarness, SERVICE, {
      sessionId: opened.sessionId,
      sessionToken: opened.sessionToken,
    });
    assertEquals(resumed.sessionId, opened.sessionId);
    const resumeUpserts =
      (resumed.sync as { upserts?: Array<{ id: string }> } | undefined)
        ?.upserts ?? [];
    assertEquals(
      resumeUpserts.filter((upsert) => upsert.id === "of:profile"),
      [],
      "resume catch-up must not deliver foreign instances without a " +
        "live lease (revalidate on resume, never trust the persisted bit)",
    );

    const pushFrom = resumedHarness.messages.length;
    await writeAliceProfile(server, aliceSession, 3, { name: "alice-3" });
    await drainDelivery(server, () => false);
    assertEquals(
      effectUpsertIds(resumedHarness.messages, pushFrom).filter(
        (id) => id === "of:profile",
      ),
      [],
      "post-resume pushes must stay filtered while no live lease is held",
    );

    alice.connection.close();
    resumedHarness.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Instance identity across the wire seam (threads r3731191411 and
// r3731191526): the wire strips scope KEYS (frames carry scope names), so
// the server must refuse what the wire cannot express — one watch set (or
// query) resolving TWO instances of one (branch, id, scope) — and must
// treat a changed `entityScopeKey` on an existing watch id as a changed
// spec, never silently the same watch.
// ---------------------------------------------------------------------------

Deno.test("a read resolving two instances of one (branch, id, scope) is refused: the wire cannot express the distinction", async () => {
  const server = newServer("memory://explicit-read-ambiguous");
  setServerExecutionConfig(true);
  try {
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const aliceKey = resolveScopeKey("user", { principal: ALICE });
    const bobKey = resolveScopeKey("user", { principal: BOB });

    // Two explicit instances of the same (id, scope) in ONE watch set:
    // both frames would serialize as (branch, id, scope: "user") and the
    // client cache keeps only one. Refused loudly instead.
    const ambiguous = await server.watchSet({
      type: "session.watch.set",
      requestId: nextRequestId("ambiguous"),
      space: SPACE,
      sessionId: serviceSession,
      watches: [{
        id: "w-ambiguous",
        kind: "graph",
        query: {
          roots: [
            {
              id: "of:profile",
              scope: "user",
              entityScopeKey: aliceKey,
              selector: { path: [], schema: false },
            },
            {
              id: "of:profile",
              scope: "user",
              entityScopeKey: bobKey,
              selector: { path: [], schema: false },
            },
          ],
        },
      }],
    }) as ResponseMessage<WatchSetResult>;
    assertEquals(ambiguous.error?.name, "ProtocolError");

    // The same ambiguity split across an existing watch and a watch.add
    // is refused too: the session's watch SET is the delivery unit.
    const first = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey, "w-first"),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(first.ok, JSON.stringify(first.error));
    const added = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("add-ambiguous"),
      space: SPACE,
      sessionId: serviceSession,
      watches: [{
        id: "w-second",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    });
    assertEquals(added.error?.name, "ProtocolError");

    // A graph.query naming both instances at once is the same wire
    // collapse (GraphQueryResult entities key by (branch, id, scope) in
    // the client's WatchView) — refused identically.
    const query = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("query-ambiguous"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [
          {
            id: "of:profile",
            scope: "user",
            entityScopeKey: aliceKey,
            selector: { path: [], schema: false },
          },
          {
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: false },
          },
        ],
      },
    });
    assertEquals(query.error?.name, "ProtocolError");

    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("watch.add with a changed entityScopeKey on an existing watch id is a changed spec, not silently the old instance", async () => {
  const server = newServer("memory://explicit-read-changed-key");
  setServerExecutionConfig(true);
  try {
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const aliceKey = resolveScopeKey("user", { principal: ALICE });
    const bobKey = resolveScopeKey("user", { principal: BOB });

    const first = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey, "w-keyed"),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(first.ok, JSON.stringify(first.error));

    // Same watch id, DIFFERENT explicit instance: the spec changed, and
    // pretending otherwise keeps tracking the old instance while the
    // caller believes it watches the new one.
    const changed = await server.watchAdd({
      type: "session.watch.add",
      requestId: nextRequestId("changed-key"),
      space: SPACE,
      sessionId: serviceSession,
      watches: [{
        id: "w-keyed",
        kind: "graph",
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: false },
          }],
        },
      }],
    });
    assertExists(
      changed.error,
      "a changed entityScopeKey must not be silently accepted as the " +
        "same watch spec",
    );

    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Delivery-failure rollback for explicit foreign instances (thread
// r3731191415): the wire frame carries scope NAMES, so rollback cannot
// recover the instance from the frame alone — the server must retain the
// frame's true instance keys. A lost foreign-instance frame must be
// REDELIVERED once sends succeed again.
// ---------------------------------------------------------------------------

Deno.test("a failed delivery of an explicit foreign-instance frame is redelivered (rollback keys the exact instance)", async () => {
  const server = newServer("memory://explicit-read-rollback");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // A connection whose callback can be made to throw: the send
    // boundary is the delivery commit point, so a throwing callback is
    // exactly an undelivered frame.
    const serviceMessages: ServerMessage[] = [];
    let effectFailuresRemaining = 0;
    const serviceConnection = server.connect((message) => {
      if (
        effectFailuresRemaining > 0 &&
        (message as { type?: string }).type === "session/effect"
      ) {
        effectFailuresRemaining -= 1;
        throw new Error("socket died (test-induced)");
      }
      serviceMessages.push(message);
    });
    await serviceConnection.receive(encodeMemoryBoundary(HELLO));
    const hello = serviceMessages.shift() as HelloOkMessage;
    assertExists(hello.sessionOpen);
    const service: Harness = {
      messages: serviceMessages,
      connection: serviceConnection,
      sessionOpen: hello.sessionOpen!,
    };
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      // Long TTL: a test lease is never renewed, and assertions about a
      // LIVE holder must not race the wall clock.
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    const watch = await server.watchSet(
      watchAliceInstance(serviceSession, aliceKey),
    ) as ResponseMessage<WatchSetResult>;
    assertExists(watch.ok, JSON.stringify(watch.error));

    // The foreign instance moves; the frame's FIRST send FAILS (one
    // induced failure — the retry pass sends normally).
    effectFailuresRemaining = 1;
    const redeliverFrom = service.messages.length;
    await writeAliceProfile(server, aliceSession, 2, { name: "alice-2" });

    // The rolled-back delivery must recompute and REDELIVER the foreign
    // upsert (a rollback that mapped the frame to the session's own
    // instance leaves the foreign entry cached as current and never
    // resends it).
    await drainDelivery(
      server,
      () =>
        effectUpsertIds(service.messages, redeliverFrom).includes("of:profile"),
    );
    const redelivered = service.messages.slice(redeliverFrom).some(
      (message) => {
        if ((message as { type?: string }).type !== "session/effect") {
          return false;
        }
        const upserts = (message as {
          effect?: {
            upserts?: Array<{ id: string; doc?: { value?: unknown } }>;
          };
        }).effect?.upserts ?? [];
        return upserts.some((upsert) =>
          upsert.id === "of:profile" &&
          JSON.stringify(upsert.doc?.value) === JSON.stringify({
              name: "alice-2",
            })
        );
      },
    );
    assertEquals(
      redelivered,
      true,
      "the lost foreign-instance frame must be redelivered once sends " +
        "succeed (rollback must key the frame's true instance)",
    );

    alice.connection.close();
    serviceConnection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("a non-canonical entity_scope_key (raw '/') is refused at admission — descendant composite keys never see it (thread r3731191505; the shared-validator fix)", async () => {
  const server = newServer("memory://explicit-read-noncanonical");
  setServerExecutionConfig(true);
  try {
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSession(service, SERVICE);
    const engine = await server.engineForSpace(SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(engine, { space: SPACE, holder, ttlMs: 600_000 }),
      true,
    );
    // Even the LIVE HOLDER cannot name a merely prefix-shaped key: the
    // tracker key vocabulary is `/`-delimited, so a raw '/' inside a
    // scope key would corrupt addressing downstream. Refused up front by
    // the canonical-grammar validator.
    for (
      const bad of ["user:a/b", "user:did:key:x", "session:a/b:c", "user:%2f"]
    ) {
      const refused = await server.graphQuery({
        type: "graph.query",
        requestId: nextRequestId("noncanonical"),
        space: SPACE,
        sessionId: serviceSession,
        query: {
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bad as never,
            selector: { path: [], schema: false },
          }],
        },
      });
      assertEquals(
        refused.error?.name,
        "ProtocolError",
        `expected refusal for ${JSON.stringify(bad)}`,
      );
      assertEquals(
        refused.error?.message.includes("malformed entity_scope_key"),
        true,
        `expected the malformed-key refusal for ${JSON.stringify(bad)}`,
      );
    }
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Phase 5 — the read row's cross-space widening and its fail-closed twin
// (protocol.md §2; verification-coverage.md's stage-F read-row entry):
//
// - FP2 (RULED 2026-08-03): the requester holds A live execution_lease on
//   the co-hosted memory server — its OWN space's lease, not necessarily
//   the read space's — so a home SpaceServer's cross-space serving reads
//   can name a FOREIGN space's instances.
// - The per-process sharpening: equality is against the FULL DR1 holder
//   minted by THIS process, so a second process sharing the service DID
//   no longer passes on this process's lease rows.
// - The delegated-scoped-read fail-closed refusal (RULED 2026-08-13, the
//   Phase-5 precondition): a co-hosted serving session's UNNAMED scoped
//   read of a space it does not hold refuses loudly instead of silently
//   resolving the delegating envelope's (empty) instance.
// ---------------------------------------------------------------------------

const HOME_SPACE = "did:key:z6Mk-explicit-read-home";

const openSessionIn = async (
  harness: Harness,
  space: string,
  principal: string,
): Promise<{ sessionId: string }> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session: {},
    invocation: {
      iss: principal,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const response = shiftMessage(harness.messages) as ResponseMessage<
    { sessionId: string; sessionOpen: SessionOpenAuthMetadata }
  >;
  assertExists(response.ok, JSON.stringify(response.error));
  harness.sessionOpen = response.ok.sessionOpen;
  return { sessionId: response.ok.sessionId };
};

Deno.test("Phase 5: a home holder names a FOREIGN space's instance under its own space's lease (FP2's widened read row)", async () => {
  const server = newServer("memory://explicit-read-fp2");
  setServerExecutionConfig(true);
  try {
    // Alice's instance lives in SPACE; the serving session's lease lives
    // in HOME_SPACE (the home SpaceServer serving cross-space reads).
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    const homeEngine = await server.engineForSpace(HOME_SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(homeEngine, {
        space: HOME_SPACE,
        holder,
        ttlMs: 600_000,
      }),
      true,
    );

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );
    const widened = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("fp2"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(
      widened.ok,
      `FP2's widened acceptance must admit a co-hosted home holder: ${
        JSON.stringify(widened.error)
      }`,
    );
    assertEquals(widened.ok.entities.length, 1);
    assertEquals(widened.ok.entities[0].document?.value, { name: "alice" });

    // A plain client with NO lease anywhere stays refused — the widening
    // admits holders, never everyone.
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("fp2-nonholder"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(refused.error?.name, "ProtocolError");

    alice.connection.close();
    service.connection.close();
    bob.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("Phase 5: a second process's lease row admits nobody here (the per-process DR1 sharpening)", async () => {
  const server = newServer("memory://explicit-read-per-process");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });
    const aliceKey = resolveScopeKey("user", { principal: ALICE });

    // The lease row was minted by ANOTHER process sharing the service
    // DID (a deploy overlap): its holder carries a foreign
    // process-instance component. The Phase-1 service-identity-only
    // equality admitted this session on that row; the sharpened check
    // must refuse — this process's serving session holds nothing.
    const engine = await server.engineForSpace(SPACE);
    const foreignProcessHolder = executionLeaseHolder(
      SERVICE,
      "00000000-dead-beef-0000-000000000000",
    );
    assertEquals(
      acquireExecutionLease(engine, {
        space: SPACE,
        holder: foreignProcessHolder,
        ttlMs: 600_000,
      }),
      true,
    );

    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("per-process"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          entityScopeKey: aliceKey,
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(
      refused.error?.name,
      "ProtocolError",
      "a session must not be admitted on ANOTHER process's lease row " +
        `(per-process sharpening): ${JSON.stringify(refused.ok)}`,
    );

    alice.connection.close();
    service.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

Deno.test("Phase 5: a co-hosted serving session's UNNAMED scoped read of a foreign space is refused fail-closed (the grant-scoped read design's interim)", async () => {
  const server = newServer("memory://explicit-read-fail-closed");
  setServerExecutionConfig(true);
  try {
    const alice = await connect(server);
    const { sessionId: aliceSession } = await openSession(alice, ALICE);
    await writeAliceProfile(server, aliceSession, 1, { name: "alice" });

    // The serving session's lease lives in HOME_SPACE; SPACE is foreign
    // to it.
    const homeEngine = await server.engineForSpace(HOME_SPACE);
    const holder = executionLeaseHolder(SERVICE);
    assertEquals(
      acquireExecutionLease(homeEngine, {
        space: HOME_SPACE,
        holder,
        ttlMs: 600_000,
      }),
      true,
    );
    const service = await connect(server);
    const { sessionId: serviceSession } = await openSessionIn(
      service,
      SPACE,
      SERVICE,
    );

    // UNNAMED scoped root: pre-Phase-5 this resolved user:<serviceDID> —
    // a silently EMPTY instance. Now it refuses loudly.
    const refused = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("fail-closed"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    });
    assertEquals(
      refused.error?.name,
      "ProtocolError",
      "an unnamed scoped read by a foreign serving session must refuse " +
        `fail-closed, never silently resolve the service instance: ${
          JSON.stringify(refused.ok)
        }`,
    );
    assertEquals(
      refused.error?.message.includes("grant-scoped read design"),
      true,
    );

    // The same session's unnamed SPACE-scope read stays free (§2b's
    // free-read row): only scoped roots are the trap.
    const spaceRead = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("space-scope"),
      space: SPACE,
      sessionId: serviceSession,
      query: {
        roots: [{
          id: "of:profile",
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(spaceRead.ok, JSON.stringify(spaceRead.error));

    // An ordinary client's unnamed scoped read is untouched (resolves
    // its own instance as today).
    const bob = await connect(server);
    const { sessionId: bobSession } = await openSession(bob, BOB);
    const bobOwn = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("bob-own"),
      space: SPACE,
      sessionId: bobSession,
      query: {
        roots: [{
          id: "of:profile",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    }) as ResponseMessage<GraphQueryResult>;
    assertExists(bobOwn.ok, JSON.stringify(bobOwn.error));

    // A serving session's unnamed scoped read of ITS OWN space (it holds
    // the lease there) keeps today's tolerated behavior — the home
    // collapsed-view path (the OW17 residual), not the cross-space trap.
    const homeService = await connect(server);
    const { sessionId: homeSession } = await openSessionIn(
      homeService,
      HOME_SPACE,
      SERVICE,
    );
    const homeRead = await server.graphQuery({
      type: "graph.query",
      requestId: nextRequestId("home-scoped"),
      space: HOME_SPACE,
      sessionId: homeSession,
      query: {
        roots: [{
          id: "of:home-doc",
          scope: "user",
          selector: { path: [], schema: false },
        }],
      },
    });
    assertExists(homeRead.ok, JSON.stringify(homeRead.error));

    alice.connection.close();
    service.connection.close();
    bob.connection.close();
    homeService.connection.close();
  } finally {
    resetServerExecutionConfig();
    await server.close();
  }
});

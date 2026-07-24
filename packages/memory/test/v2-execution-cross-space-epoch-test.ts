// C3.2 — foreign authorization epochs (the C3A3-AMENDED bump rule).
//
// Engine-level fixtures pin the decision table on the durable
// `authorization_epoch` table, written INSIDE `applyCommitTransaction`
// (transactional with the ACL apply — same SQLite transaction, no
// window):
//  (a) valid→valid entry changes bump EXACTLY the affected principals
//      (old∪new membership/capability changes) and never others; a
//      wildcard/ANYONE change bumps the space-wide floor;
//  (b) EVERY validity-state transition bumps the floor — including the
//      C3A3 killer case: genesis on a previously ACL-less (implicit
//      access) POPULATED space bumps the floor even though no principal
//      appears in either list, so a principal holding a pre-genesis
//      epoch stamp (implicit access) fails EQUALITY revalidation and is
//      revocable via the floor. This fixture IS the amendment's test:
//      the scout's bare old∪new+ANYONE rule leaves it red.
//  (c) equality revalidation: an identical-content ACL rewrite (key
//      order included) bumps NOTHING;
//  (d) an exact replay of an ACL commit does not double-bump (and
//      carries no bumps for the host to republish);
//  (e) durability: reopen the engine — epochs persist.
//
// Server-level fixtures pin the C3.1 wiring:
//  (f) accepted ACL commits publish `foreign-authorization-epoch.bump`
//      over the in-process transport in commit order (v1 fan-out: every
//      registered peer space — C3.3a owns subscription narrowing), and
//      the receiving-side remote cache max-merges monotonically
//      (out-of-order redelivery never regresses);
//  (g) the `foreign-authorization-epoch.query` round-trip answers
//      floor + requested principals from the durable table; a requested
//      principal with no row is reported floor-only (absent from the
//      answer — the C3A3 fail-closed reading), and the merged remote
//      snapshot reflects it.
//
// NOT built here (dated 2026-07-18): claim binding + idle revocation
// (C3.7), the apply fence (C3.8), read-time liveness (C3.4). These
// fixtures bind the SUBSTRATE those consult: bump correctness, durable
// storage, publication, and the query answer.
//
// Barrier-driven throughout: every await is a transact response, the
// server settle barrier, or an engine reopen — no sleeps.
import { assert, assertEquals, assertExists } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  aclDocId,
  applyCommit,
  authorizationEpochBumpsOf,
  authorizationEpochSnapshot,
  close as closeEngine,
  createBranch,
  effectiveAuthorizationEpoch,
  type Engine,
  isAppliedCommitReplay,
  open as openEngine,
} from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type Operation,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
} from "../v2.ts";
import {
  type CrossSpaceMessage,
  type ForeignAuthorizationEpochBump,
  parseCrossSpaceMessage,
} from "../v2/cross-space.ts";

const SPACE = "did:key:z6Mk-xsp-epoch-authority";
const PEER_SPACE = "did:key:z6Mk-xsp-epoch-home";
const ALICE = "did:key:z6Mk-xsp-epoch-alice";
const BOB = "did:key:z6Mk-xsp-epoch-bob";
const CAROL = "did:key:z6Mk-xsp-epoch-carol";
const TEST_AUDIENCE = "did:key:z6Mk-xsp-epoch-audience";

// --------------------------------------------------------------------------
// Engine-level: the bump decision table on the durable table.
// --------------------------------------------------------------------------

interface EngineApplier {
  engine: Engine;
  /** Apply a fresh commit (auto-increments localSeq). */
  apply(operations: Operation[], branch?: string): ReturnType<
    typeof applyCommit
  >;
}

const engineApplier = (engine: Engine): EngineApplier => {
  let localSeq = 0;
  return {
    engine,
    apply: (operations, branch) =>
      applyCommit(engine, {
        sessionId: "epoch-engine-session",
        space: SPACE,
        commit: {
          localSeq: ++localSeq,
          ...(branch !== undefined ? { branch } : {}),
          reads: { confirmed: [], pending: [] },
          operations,
        },
      }),
  };
};

const setAcl = (value: unknown): Operation => ({
  op: "set",
  id: aclDocId(SPACE),
  value: { value } as { value: Record<string, unknown> },
});

Deno.test("C3.2 engine: every validity-state transition bumps the floor — genesis on a populated implicit-access space (the C3A3 killer case), retraction, repair", async () => {
  const dir = await Deno.makeTempDir();
  const engine = await openEngine({
    url: toFileUrl(`${dir}/epoch-authority.sqlite`),
  });
  const { apply } = engineApplier(engine);
  try {
    // Populate the space with NO ACL: every authenticated principal
    // holds implicit access (the pre-launch compatibility rule). An
    // ordinary commit bumps nothing.
    const populate = apply([{
      op: "set",
      id: "of:doc-1",
      value: { value: { hello: "world" } },
    }]);
    assertEquals(authorizationEpochBumpsOf(populate), undefined);
    assertEquals(authorizationEpochSnapshot(engine), { floor: 0, epochs: [] });
    // The stamp an implicit-access holder (Bob — in NO list, ever) would
    // bind pre-genesis:
    assertEquals(effectiveAuthorizationEpoch(engine, BOB), 0);

    // THE AMENDMENT'S FIXTURE (C3A3): genesis on the populated ACL-less
    // space. Bob appears in neither the (nonexistent) old list nor the
    // new one — bare old∪new+ANYONE bumps nothing for him — yet his
    // implicit capability just vanished. The missing→valid transition
    // bumps the space-wide floor, so his pre-genesis stamp fails
    // EQUALITY revalidation and the claim is revocable via the floor.
    const genesis = apply([setAcl({ [ALICE]: "OWNER" })]);
    assertEquals(authorizationEpochBumpsOf(genesis), [
      { target: { kind: "floor" }, epoch: 1 },
    ]);
    assertEquals(authorizationEpochSnapshot(engine), { floor: 1, epochs: [] });
    assert(
      effectiveAuthorizationEpoch(engine, BOB) !== 0,
      "a pre-genesis epoch stamp must fail equality revalidation " +
        "after genesis (the floor covers principals in no list)",
    );
    assertEquals(effectiveAuthorizationEpoch(engine, BOB), 1);

    // valid→invalid (retraction tombstone): floor bump. The invalid
    // state fails everyone closed — capability changed for every
    // principal enumerable in no list.
    const retract = apply([{ op: "delete", id: aclDocId(SPACE) }]);
    assertEquals(authorizationEpochBumpsOf(retract), [
      { target: { kind: "floor" }, epoch: 2 },
    ]);

    // invalid→valid (repair): floor bump again.
    const repair = apply([setAcl({ [ALICE]: "OWNER" })]);
    assertEquals(authorizationEpochBumpsOf(repair), [
      { target: { kind: "floor" }, epoch: 3 },
    ]);
    assertEquals(authorizationEpochSnapshot(engine), { floor: 3, epochs: [] });
  } finally {
    closeEngine(engine);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("C3.2 engine: valid→valid diffs bump exactly the affected principals; ANYONE changes bump the floor; equality rewrite bumps nothing; replay does not double-bump; epochs are durable", async () => {
  const dir = await Deno.makeTempDir();
  const url = toFileUrl(`${dir}/epoch-authority.sqlite`);
  let engine = await openEngine({ url });
  const applier = engineApplier(engine);
  try {
    // Genesis (floor 1 via the missing→valid transition).
    applier.apply([setAcl({ [ALICE]: "OWNER" })]);
    assertEquals(authorizationEpochSnapshot(engine), { floor: 1, epochs: [] });

    // (a) Entry ADD: exactly Bob bumps; Alice and Carol stay at the
    // floor. old∪new = {ALICE (unchanged), BOB (added)}.
    const add = applier.apply([
      setAcl({ [ALICE]: "OWNER", [BOB]: "WRITE" }),
    ]);
    assertEquals(authorizationEpochBumpsOf(add), [
      { target: { kind: "principal", principal: BOB }, epoch: 2 },
    ]);
    assertEquals(effectiveAuthorizationEpoch(engine, BOB), 2);
    assertEquals(
      effectiveAuthorizationEpoch(engine, ALICE),
      1,
      "an unchanged principal keeps its (floor) epoch — no bump",
    );
    assertEquals(effectiveAuthorizationEpoch(engine, CAROL), 1);

    // (c) Equality revalidation: identical effective content — here
    // even with reordered keys — bumps NOTHING.
    const rewrite = applier.apply([
      setAcl({ [BOB]: "WRITE", [ALICE]: "OWNER" }),
    ]);
    assertEquals(isAppliedCommitReplay(rewrite), false);
    assertEquals(authorizationEpochBumpsOf(rewrite), undefined);
    assertEquals(authorizationEpochSnapshot(engine), {
      floor: 1,
      epochs: [{ principal: BOB, epoch: 2 }],
    });

    // (a) Entry CHANGE: Bob WRITE→READ bumps exactly Bob.
    const change = applier.apply([
      setAcl({ [ALICE]: "OWNER", [BOB]: "READ" }),
    ]);
    assertEquals(authorizationEpochBumpsOf(change), [
      { target: { kind: "principal", principal: BOB }, epoch: 3 },
    ]);

    // (a) Entry REMOVE (old∪new membership): dropping Bob bumps Bob.
    const remove = applier.apply([setAcl({ [ALICE]: "OWNER" })]);
    assertEquals(authorizationEpochBumpsOf(remove), [
      { target: { kind: "principal", principal: BOB }, epoch: 4 },
    ]);

    // (a) ANYONE change: the wildcard grants to principals enumerable in
    // no list — the floor bumps, per-principal rows stay.
    const wildcard = applier.apply([
      setAcl({ [ALICE]: "OWNER", "*": "READ" }),
    ]);
    assertEquals(authorizationEpochBumpsOf(wildcard), [
      { target: { kind: "floor" }, epoch: 5 },
    ]);
    assertEquals(effectiveAuthorizationEpoch(engine, CAROL), 5);
    assertEquals(
      effectiveAuthorizationEpoch(engine, BOB),
      5,
      "the floor covers principals whose row is older",
    );

    // A write to the ACL doc id on a NON-DEFAULT branch does not change
    // the authority-visible (default branch) ACL — no bump. The bump
    // derives from the authority state delta, not from a commit naming
    // the id.
    createBranch(engine, "scratch");
    const offBranch = applier.apply(
      [setAcl({ [ALICE]: "OWNER" })],
      "scratch",
    );
    assertEquals(authorizationEpochBumpsOf(offBranch), undefined);
    assertEquals(authorizationEpochSnapshot(engine).floor, 5);

    // (d) Exact replay of the wildcard commit: replays return before the
    // apply path — no re-bump, no bumps to republish.
    const replay = applyCommit(engine, {
      sessionId: "epoch-engine-session",
      space: SPACE,
      commit: {
        // The applier auto-increments localSeq from 1; the wildcard
        // commit above was the sixth apply, so this re-sends localSeq 6
        // with identical content — the exact-replay shape.
        localSeq: 6,
        reads: { confirmed: [], pending: [] },
        operations: [setAcl({ [ALICE]: "OWNER", "*": "READ" })],
      },
    });
    assert(isAppliedCommitReplay(replay), "the re-sent commit replays");
    assertEquals(authorizationEpochBumpsOf(replay), undefined);
    assertEquals(authorizationEpochSnapshot(engine).floor, 5);

    // (e) Durability: reopen the engine — the table persists.
    const expected = authorizationEpochSnapshot(engine);
    closeEngine(engine);
    engine = await openEngine({ url });
    assertEquals(authorizationEpochSnapshot(engine), expected);
    assertEquals(effectiveAuthorizationEpoch(engine, BOB), 5);
  } finally {
    closeEngine(engine);
    await Deno.remove(dir, { recursive: true });
  }
});

// --------------------------------------------------------------------------
// Server-level: publication over C3.1, the remote cache, the query.
// --------------------------------------------------------------------------

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

/** Server whose session principal is taken (untested-crypto, test-only)
 * from `invocation.iss`, mirroring the v2-server-acl-test harness. */
const createAclServer = (
  store: URL,
  acl?: { mode: "off" | "observe" | "enforce" },
) =>
  new Server({
    store,
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl,
  });

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const connectHarness = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = messages.shift() as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen };
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

const openSession = async (
  { connection, messages, sessionOpen }: Harness,
  space: string,
  principal: string,
  session: SessionDescriptor = {},
): Promise<ResponseMessage<SessionOpenResult>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session,
    invocation: {
      iss: principal,
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  const response = messages.shift() as ResponseMessage<SessionOpenResult>;
  assertExists(response, "expected a session.open response");
  return response;
};

const transactSet = async (
  { connection, messages }: Harness,
  space: string,
  sessionId: string,
  id: string,
  value: unknown,
  localSeq: number,
): Promise<ResponseMessage<{ seq: number }>> => {
  await connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: nextRequestId("tx"),
    space,
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value } }],
    },
  }));
  const response = messages.shift() as ResponseMessage<{ seq: number }>;
  assertExists(response, "expected a transact response");
  return response;
};

/** Tap every frame crossing the server's in-process transport (the
 * loopback channel broadcasts to all onMessage handlers). */
const tapCrossSpaceFrames = (server: Server): CrossSpaceMessage[] => {
  const frames: CrossSpaceMessage[] = [];
  server.crossSpaceRouter().transport.channelTo(SPACE).onMessage((wire) => {
    const parsed = parseCrossSpaceMessage(wire);
    if (parsed.ok) frames.push(parsed.message);
  });
  return frames;
};

type ServerInternals = {
  settleCrossSpaceDeliveries(): Promise<void>;
};

const epochFrames = (
  frames: readonly CrossSpaceMessage[],
): ForeignAuthorizationEpochBump[] =>
  frames.filter((frame): frame is ForeignAuthorizationEpochBump =>
    frame.type === "foreign-authorization-epoch.bump"
  );

const authorityEpochTableFromStore = async (
  store: URL,
  space: string,
): Promise<ReturnType<typeof authorizationEpochSnapshot>> => {
  const engine = await openEngine({
    url: resolveSpaceStoreUrl(store, space as `did:${string}:${string}`),
  });
  try {
    return authorizationEpochSnapshot(engine);
  } finally {
    closeEngine(engine);
  }
};

Deno.test("C3.2 server: ACL commits publish epoch bumps over the transport in commit order; the peer cache max-merges; replay republishes nothing; the query answers floor + principals with absent-principal floor-only", async () => {
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = createAclServer(store, { mode: "enforce" });
  const frames = tapCrossSpaceFrames(server);
  const authority = await connectHarness(server);
  const alicePeer = await connectHarness(server);
  // Session-open challenges are single-use per connection, so Alice's
  // authority-space session rides its own connection (the ACL-test
  // harness convention).
  const alice = await connectHarness(server);
  try {
    // Register the peer HOME space first (serve-path registration): the
    // v1 fan-out targets every registered peer space.
    const peer = await openSession(alicePeer, PEER_SPACE, ALICE);
    assertExists(peer.ok, "the peer home space must open (fresh space)");

    // Genesis on the authority space: missing→valid → floor bump 1,
    // published to the registered peer.
    const authoritySession = await openSession(authority, SPACE, SPACE);
    assertExists(authoritySession.ok);
    const genesis = await transactSet(
      authority,
      SPACE,
      authoritySession.ok.sessionId,
      aclDocId(SPACE),
      { [ALICE]: "OWNER" },
      1,
    );
    assertExists(genesis.ok, "the space identity writes the genesis ACL");

    // Entry add by the OWNER: valid→valid diff → Bob's row bumps to 2.
    const aliceSession = await openSession(alice, SPACE, ALICE);
    assertExists(aliceSession.ok);
    const grantBob = await transactSet(
      alice,
      SPACE,
      aliceSession.ok.sessionId,
      aclDocId(SPACE),
      { [ALICE]: "OWNER", [BOB]: "WRITE" },
      1,
    );
    assertExists(grantBob.ok);

    // (f) Publication in COMMIT ORDER over the in-process transport, one
    // bump per registered peer space (v1 fan-out; C3.3a narrows to
    // subscriptions).
    const bumps = epochFrames(frames);
    assertEquals(
      bumps.map((bump) => ({
        toSpace: bump.toSpace,
        fromSpace: bump.fromSpace,
        target: bump.target,
        epoch: bump.epoch,
      })),
      [
        {
          toSpace: PEER_SPACE,
          fromSpace: SPACE,
          target: { kind: "floor" },
          epoch: 1,
        },
        {
          toSpace: PEER_SPACE,
          fromSpace: SPACE,
          target: { kind: "principal", principal: BOB },
          epoch: 2,
        },
      ],
      "bumps cross the transport in commit order, addressed per peer",
    );

    // The receiving-side cache merged both components (keyed by the
    // link + the authority space it speaks for).
    const linkId = server.crossSpaceRouter().transport.channelTo(SPACE).linkId;
    assertEquals(server.remoteAuthorizationEpochSnapshot(linkId, SPACE), {
      floor: 1,
      epochs: [{ principal: BOB, epoch: 2 }],
    });
    assertEquals(
      server.effectiveRemoteAuthorizationEpoch(linkId, SPACE, BOB),
      2,
    );
    assertEquals(
      server.effectiveRemoteAuthorizationEpoch(linkId, SPACE, ALICE),
      1,
      "a principal with no row reports the learned floor",
    );
    assertEquals(
      server.effectiveRemoteAuthorizationEpoch(linkId, "did:key:unknown", BOB),
      undefined,
      "an entirely unknown (link, space) is undefined — fail closed",
    );

    // The durable authority table backs it all (reopened from the
    // store — server-side durability evidence).
    assertEquals(await authorityEpochTableFromStore(store, SPACE), {
      floor: 1,
      epochs: [{ principal: BOB, epoch: 2 }],
    });

    // (d) Idempotent apply at the server seam: replaying Alice's exact
    // ACL commit re-responds from the replay path and republishes
    // NOTHING (the epoch table is untouched, no new frames).
    const framesBefore = frames.length;
    const replayed = await transactSet(
      alice,
      SPACE,
      aliceSession.ok.sessionId,
      aclDocId(SPACE),
      { [ALICE]: "OWNER", [BOB]: "WRITE" },
      1,
    );
    assertExists(replayed.ok, "the replay is accepted");
    await (server as unknown as ServerInternals).settleCrossSpaceDeliveries();
    assertEquals(
      frames.length,
      framesBefore,
      "a replayed ACL commit publishes no bumps",
    );
    assertEquals((await authorityEpochTableFromStore(store, SPACE)).floor, 1);

    // (g) The query round-trip: floor + requested principals from the
    // durable table; Carol (no row) is reported floor-only — absent
    // from the answer, her effective epoch IS the floor.
    const answered = await server.queryForeignAuthorizationEpochs(
      PEER_SPACE,
      SPACE,
      [BOB, CAROL],
    );
    assertEquals(answered, {
      floor: 1,
      epochs: [{ principal: BOB, epoch: 2 }],
    });
    assertEquals(
      server.effectiveRemoteAuthorizationEpoch(linkId, SPACE, CAROL),
      1,
      "absent principal fails closed to the floor",
    );
    const queryFrames = frames.filter((frame) =>
      frame.type === "foreign-authorization-epoch.query" ||
      frame.type === "foreign-authorization-epoch.query.result"
    );
    assertEquals(
      queryFrames.map((frame) => frame.type),
      [
        "foreign-authorization-epoch.query",
        "foreign-authorization-epoch.query.result",
      ],
      "the query and its answer crossed the transport",
    );
  } finally {
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true }).catch(() => {});
  }
});

Deno.test("C3.2 server (the C3A3 amendment across a mode flip): genesis on a space populated under acl-off implicit access floor-bumps and revokes pre-genesis stamps", async () => {
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  try {
    // Lifetime 1 (acl off): Bob populates the space under implicit
    // access — he will appear in NO ACL, ever.
    {
      const server = createAclServer(store);
      const bob = await connectHarness(server);
      const opened = await openSession(bob, SPACE, BOB);
      assertExists(opened.ok);
      const write = await transactSet(
        bob,
        SPACE,
        opened.ok.sessionId,
        "of:doc-by-bob",
        { hello: "from bob" },
        1,
      );
      assertExists(write.ok);
      await server.close();
    }
    assertEquals(await authorityEpochTableFromStore(store, SPACE), {
      floor: 0,
      epochs: [],
    }, "no ACL has ever changed — Bob's pre-genesis stamp would be 0");

    // Lifetime 2 (acl enforce): the space identity writes the genesis
    // ACL. Bob is in neither list; the floor bump is the ONLY thing
    // that can revoke his implicit-access stamp.
    const server = createAclServer(store, { mode: "enforce" });
    const frames = tapCrossSpaceFrames(server);
    const authority = await connectHarness(server);
    const peerHarness = await connectHarness(server);
    try {
      const peer = await openSession(peerHarness, PEER_SPACE, ALICE);
      assertExists(peer.ok);
      const session = await openSession(authority, SPACE, SPACE);
      assertExists(session.ok);
      const genesis = await transactSet(
        authority,
        SPACE,
        session.ok.sessionId,
        aclDocId(SPACE),
        { [ALICE]: "OWNER" },
        1,
      );
      assertExists(
        genesis.ok,
        "genesis on the populated ACL-less space is accepted",
      );

      const table = await authorityEpochTableFromStore(store, SPACE);
      assertEquals(
        table.floor,
        1,
        "genesis on a populated implicit-access space bumps the floor " +
          "even though no principal appears in either list (C3A3)",
      );
      assertEquals(table.epochs, []);
      // Equality revalidation of Bob's pre-genesis stamp (0) against the
      // effective epoch now fails — the claim is revocable via the
      // floor. (C3.7 wires the revoke; this pins the substrate.)
      const bumped = epochFrames(frames).map((bump) => ({
        fromSpace: bump.fromSpace,
        toSpace: bump.toSpace,
        target: bump.target,
        epoch: bump.epoch,
      }));
      assertEquals(bumped, [
        {
          fromSpace: SPACE,
          toSpace: PEER_SPACE,
          target: { kind: "floor" },
          epoch: 1,
        },
      ], "the floor bump reached the registered peer");
    } finally {
      await server.close().catch(() => {});
    }
  } finally {
    await Deno.remove(storePath, { recursive: true }).catch(() => {});
  }
});

Deno.test("C3.2 receiving cache: out-of-order redelivery and stale query answers never regress (monotonic max-merge per component)", async () => {
  const storePath = await Deno.makeTempDir();
  const store = toFileUrl(`${storePath}/`);
  const server = createAclServer(store, { mode: "enforce" });
  const harness = await connectHarness(server);
  const AUTHORITY = "did:key:z6Mk-xsp-epoch-fake-authority";
  try {
    // Serve the home space so its inbox exists; register a scripted
    // AUTHORITY endpoint directly on the server's router (the harness
    // stands in for the peer host's send side, like the C3.1 fixture).
    const opened = await openSession(harness, PEER_SPACE, ALICE);
    assertExists(opened.ok);
    const router = server.crossSpaceRouter();
    router.register(AUTHORITY, () => {});
    const link = router.link(AUTHORITY, PEER_SPACE);
    const settle = () =>
      (server as unknown as ServerInternals).settleCrossSpaceDeliveries();

    // Redelivered/reordered bumps: newest first, stale afterwards.
    link.send({
      type: "foreign-authorization-epoch.bump",
      target: { kind: "principal", principal: BOB },
      epoch: 5,
    });
    link.send({
      type: "foreign-authorization-epoch.bump",
      target: { kind: "principal", principal: BOB },
      epoch: 3,
    });
    link.send({
      type: "foreign-authorization-epoch.bump",
      target: { kind: "floor" },
      epoch: 4,
    });
    link.send({
      type: "foreign-authorization-epoch.bump",
      target: { kind: "floor" },
      epoch: 2,
    });
    await settle();
    assertEquals(
      server.remoteAuthorizationEpochSnapshot(link.linkId, AUTHORITY),
      { floor: 4, epochs: [{ principal: BOB, epoch: 5 }] },
      "components max-merge independently; redelivery never regresses",
    );
    assertEquals(
      server.effectiveRemoteAuthorizationEpoch(link.linkId, AUTHORITY, CAROL),
      4,
      "no-row principals ride the merged floor",
    );

    // A stale query answer (e.g. reordered around a fresher bump) also
    // never regresses; fresher components still merge in.
    link.send({
      type: "foreign-authorization-epoch.query.result",
      requestId: "xsp-epoch-stale-answer",
      epochFloor: 1,
      epochs: [
        { principal: BOB, epoch: 2 },
        { principal: CAROL, epoch: 6 },
      ],
    });
    await settle();
    assertEquals(
      server.remoteAuthorizationEpochSnapshot(link.linkId, AUTHORITY),
      {
        floor: 4,
        epochs: [
          { principal: BOB, epoch: 5 },
          { principal: CAROL, epoch: 6 },
        ],
      },
      "stale answer components are ignored; fresher ones merge",
    );
  } finally {
    await server.close().catch(() => {});
    await Deno.remove(storePath, { recursive: true }).catch(() => {});
  }
});

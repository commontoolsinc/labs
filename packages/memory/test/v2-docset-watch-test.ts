import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import {
  type EntitySnapshot,
  setServerPrimaryExecutionGraphRetirementConfig,
  type WatchSpec,
} from "../v2.ts";

// --- F3 doc-set watch kind: additive WatchSpec, absent-false subcapability,
// server membership fan-out via per-wave point reads. ---

// FW5 (FB9): the F5 rollout dial gates doc-set ADMISSION per space. This
// suite exercises F3/F4 semantics that are orthogonal to the dial, so admit
// every space via the wildcard for the whole file (module state is
// per-test-file). Dial authority itself is pinned in
// v2-feed-retirement-test.ts.
setServerPrimaryExecutionGraphRetirementConfig(["*"]);

const AUDIENCE = "did:key:z6Mk-docset-audience";
const SPONSOR = "did:key:z6Mk-docset-sponsor";
// Colon-bearing DIDs exercise the canonical scope keys.
const ALICE = "did:key:z6Mk-docset-alice";
const BOB = "did:key:z6Mk-docset-bob";

const createServer = (
  name: string,
  options: { docSet?: boolean } = {},
): Server =>
  new Server(
    {
      store: new URL(`memory://${name}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message: { authorization?: unknown }) => {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      protocolFlags: {
        serverPrimaryExecutionV1: true,
        serverPrimaryExecutionClaimRoutingV1: true,
        // Doc-set watch is a subcapability of the base feed capability; a
        // server built without it must reject the `docs` kind (test below).
        serverPrimaryExecutionDocSetWatchV1: options.docSet ?? true,
      },
      acl: { mode: "off", serviceDids: [] },
    } as unknown as ConstructorParameters<typeof Server>[0],
  );

const connectClient = (
  server: Server,
  options: { docSet?: boolean } = {},
): Promise<MemoryClient.Client> =>
  MemoryClient.connect({
    transport: MemoryClient.loopback(server),
    protocolFlags: {
      serverPrimaryExecutionV1: true,
      serverPrimaryExecutionClaimRoutingV1: true,
      serverPrimaryExecutionDocSetWatchV1: options.docSet ?? true,
    },
  } as MemoryClient.ConnectOptions);

const mountAs = (
  client: MemoryClient.Client,
  space: string,
  principal: string,
): Promise<MemoryClient.SpaceSession> =>
  client.mount(space, {}, (_space, _session, context) => ({
    invocation: { aud: context.audience, challenge: context.challenge.value },
    authorization: { principal },
  }));

const docsWatch = (
  id: string,
  docs: Array<{ id: string; scope?: "space" | "user" }>,
): WatchSpec => ({ id, kind: "docs", docs } as unknown as WatchSpec);

const idDoc = (entity: EntitySnapshot) => ({
  id: entity.id,
  document: entity.document,
});

const setDoc = (
  session: MemoryClient.SpaceSession,
  localSeq: number,
  id: string,
  value: string,
  scope?: "user",
) =>
  session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id,
      ...(scope !== undefined ? { scope } : {}),
      value: { value },
    }],
  });

Deno.test("doc-set membership fans out exact per-session deltas with zero graph traversal", async () => {
  const space = "did:key:z6Mk-docset-fanout";
  const server = createServer("memory-v2-docset-fanout");
  const writerClient = await connectClient(server);
  const aClient = await connectClient(server);
  const bClient = await connectClient(server);
  const cClient = await connectClient(server);
  try {
    const writer = await mountAs(writerClient, space, SPONSOR);
    const a = await mountAs(aClient, space, SPONSOR);
    const b = await mountAs(bClient, space, SPONSOR);
    const c = await mountAs(cClient, space, SPONSOR);

    // Members registered against docs that do not yet exist (FA14: address
    // membership has no existence requirement).
    const aView = await a.watchSet([docsWatch("a", [{ id: "of:x" }])]);
    const bView = await b.watchSet([
      docsWatch("b", [{ id: "of:x" }, { id: "of:y" }]),
    ]);
    const cView = await c.watchSet([docsWatch("c", [{ id: "of:y" }])]);
    assertEquals(aView.entities, []);
    assertEquals(bView.entities, []);
    assertEquals(cView.entities, []);

    const aNext = aView.subscribe().next();
    const bNext = bView.subscribe().next();
    const cNext = cView.subscribe().next();

    const graphsBefore = server.feedStats.refreshGraphsRefreshed;
    // One wave creates both docs (create-after-link delivery).
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:x", value: { value: "X1" } },
        { op: "set", id: "of:y", value: { value: "Y1" } },
      ],
    });

    await aNext;
    await bNext;
    await cNext;

    // Exact deltas: each session receives ONLY its members, nothing else.
    assertEquals(aView.entities.map(idDoc), [
      { id: "of:x", document: { value: "X1" } },
    ]);
    assertEquals(
      bView.entities.map(idDoc).toSorted((l, r) => l.id.localeCompare(r.id)),
      [
        { id: "of:x", document: { value: "X1" } },
        { id: "of:y", document: { value: "Y1" } },
      ],
    );
    assertEquals(cView.entities.map(idDoc), [
      { id: "of:y", document: { value: "Y1" } },
    ]);

    // Zero schema/link traversal for doc-set surfaces: the graph refresh path
    // never ran, and the point reads recorded zero DAG traversals.
    assertEquals(server.feedStats.refreshGraphsRefreshed, graphsBefore);
    assertEquals(
      server.feedStats.traversalByOperation["session.watch.refresh"],
      undefined,
    );
    const pointReads =
      server.feedStats.traversalByOperation["session.docset.read"];
    assertExists(pointReads);
    assertEquals(pointReads.dagTraversals, 0);
    assertEquals(pointReads.schemaTraversals, 0);
    // Four member deltas total: X→A, X&Y→B, Y→C.
    assertEquals(server.feedStats.docSetMemberDeliveries, 4);
  } finally {
    await writerClient.close();
    await aClient.close();
    await bClient.close();
    await cClient.close();
    await server.close();
  }
});

Deno.test("a doc-set wave and a graph wave fold into one frame at one watermark (FA1)", async () => {
  const space = "did:key:z6Mk-docset-watermark";
  const server = createServer("memory-v2-docset-watermark");
  const writerClient = await connectClient(server);
  const watcherClient = await connectClient(server);
  try {
    const writer = await mountAs(writerClient, space, SPONSOR);
    const watcher = await mountAs(watcherClient, space, SPONSOR);

    // A session holding BOTH a graph watch (of:z) and a doc-set member (of:x).
    const view = await watcher.watchSet([
      docsWatch("docs", [{ id: "of:x" }]),
      {
        id: "graph",
        kind: "graph",
        query: {
          roots: [{ id: "of:z", selector: { path: [], schema: false } }],
        },
      },
    ]);
    const next = view.subscribe().next();

    // One commit dirties both surfaces; the complete watch surface must be
    // proven current through the same toSeq in a single emission.
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:x", value: { value: "member" } },
        { op: "set", id: "of:z", value: { value: "graph" } },
      ],
    });

    const delivered = await next;
    assertEquals(delivered.done, false);
    // The FIRST (and only) emission already carries BOTH surfaces — a split
    // delivery would resolve this next() with just one of them. This is the
    // observable form of "one emission point per session per wave".
    const deliveredIds = delivered.value.entities
      .map((entity: EntitySnapshot) => entity.id)
      .toSorted((l: string, r: string) => l.localeCompare(r));
    assertEquals(deliveredIds, ["of:x", "of:z"]);
    assertEquals(
      view.entities.map(idDoc).toSorted((l, r) => l.id.localeCompare(r.id)),
      [
        { id: "of:x", document: { value: "member" } },
        { id: "of:z", document: { value: "graph" } },
      ],
    );
    // The frame's toSeq is the server's data sequence: the whole surface is
    // proven current through it (no split delivery lagging behind).
    assertEquals(delivered.value.serverSeq, view.serverSeq);
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});

Deno.test("scoped doc-set members deliver per-session point reads, never another principal's instance (FA2)", async () => {
  const space = "did:key:z6Mk-docset-scoped";
  const server = createServer("memory-v2-docset-scoped");
  const aliceWatchClient = await connectClient(server);
  const aliceWriteClient = await connectClient(server);
  const bobClient = await connectClient(server);
  try {
    const aliceWatcher = await mountAs(aliceWatchClient, space, ALICE);
    const aliceWriter = await mountAs(aliceWriteClient, space, ALICE);
    const bob = await mountAs(bobClient, space, BOB);

    const view = await aliceWatcher.watchSet([
      docsWatch("u", [{ id: "of:u", scope: "user" }]),
    ]);
    assertEquals(view.entities, []);

    // Bob writes HIS user instance first — alice must never see it.
    const bobThenAlice = view.subscribe().next();
    await setDoc(bob, 1, "of:u", "BOB", "user");
    // Then a DIFFERENT alice session writes alice's instance.
    await setDoc(aliceWriter, 1, "of:u", "ALICE", "user");

    const delivered = await bobThenAlice;
    assertEquals(delivered.done, false);
    // Exactly alice's instance, resolved by the per-session point read.
    assertEquals(view.entities.map(idDoc), [
      { id: "of:u", document: { value: "ALICE" } },
    ]);
    // The delivered instance carries alice's resolved scope key, not bob's.
    assertEquals(
      view.entities[0].scopeKey,
      Engine.userExecutionContextKey(ALICE),
    );
  } finally {
    await aliceWatchClient.close();
    await aliceWriteClient.close();
    await bobClient.close();
    await server.close();
  }
});

Deno.test("a session's own committed write is echo-suppressed; a peer still receives it", async () => {
  const space = "did:key:z6Mk-docset-echo";
  const server = createServer("memory-v2-docset-echo");
  const aClient = await connectClient(server);
  const bClient = await connectClient(server);
  try {
    const a = await mountAs(aClient, space, SPONSOR);
    const b = await mountAs(bClient, space, SPONSOR);

    const aView = await a.watchSet([docsWatch("a", [{ id: "of:x" }])]);
    const bView = await b.watchSet([docsWatch("b", [{ id: "of:x" }])]);

    const bNext = bView.subscribe().next();
    const deliveriesBefore = server.feedStats.docSetMemberDeliveries;

    // A is the writer AND a member watcher of of:x.
    await setDoc(a, 1, "of:x", "written-by-a");

    // B (a peer) receives the write.
    const delivered = await bNext;
    assertEquals(delivered.done, false);
    assertEquals(bView.entities.map(idDoc), [
      { id: "of:x", document: { value: "written-by-a" } },
    ]);
    // A never receives its own echo on the doc-set channel.
    assertEquals(aView.entities, []);
    // Exactly one member delivery crossed the wire (B's) — A's was suppressed.
    assertEquals(server.feedStats.docSetMemberDeliveries, deliveriesBefore + 1);
  } finally {
    await aClient.close();
    await bClient.close();
    await server.close();
  }
});

Deno.test("resumed catch-up re-reads members incrementally, never a reseed (FA15)", async () => {
  const space = "did:key:z6Mk-docset-resume";
  const server = createServer("memory-v2-docset-resume");
  const writerClient = await connectClient(server);
  const watcherClient = await connectClient(server);
  try {
    const writer = await mountAs(writerClient, space, SPONSOR);
    const watcher = await mountAs(watcherClient, space, SPONSOR);
    await setDoc(writer, 1, "of:x", "v1");

    const view = await watcher.watchSet([docsWatch("a", [{ id: "of:x" }])]);
    // Initial registration seeds the current value.
    assertEquals(view.entities.map(idDoc), [
      { id: "of:x", document: { value: "v1" } },
    ]);
    const sessionId = watcher.sessionId;

    // A resume with no intervening commits re-reads the member INCREMENTALLY:
    // its seq is already delivered (lastSentSeq), so nothing re-ships.
    const idle = await server.syncSessionForConnection(space, sessionId);
    assert(
      idle === null ||
        (idle.effect.type === "sync" && idle.effect.upserts.length === 0),
      "an idle resume must not re-deliver an already-sent member",
    );

    // A commit while "away" advances the member; the next resume delivers only
    // the incremental delta.
    await setDoc(writer, 2, "of:x", "v2");
    const resumed = await server.syncSessionForConnection(space, sessionId);
    assertExists(resumed);
    assertEquals(resumed.effect.type, "sync");
    const upserts = (resumed.effect as { upserts: Array<{ doc?: unknown }> })
      .upserts;
    assertEquals(upserts.map((u) => u.doc), [{ value: "v2" }]);
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});

Deno.test("a non-negotiating server cleanly rejects the docs watch kind", async () => {
  const space = "did:key:z6Mk-docset-reject";
  // Server advertises no doc-set subcapability; the client still sends it.
  const server = createServer("memory-v2-docset-reject", { docSet: false });
  const client = await connectClient(server, { docSet: true });
  try {
    const session = await mountAs(client, space, SPONSOR);
    let rejected: unknown;
    try {
      await session.watchSet([docsWatch("a", [{ id: "of:x" }])]);
    } catch (error) {
      rejected = error;
    }
    assertExists(rejected);
    assertEquals((rejected as { name?: string }).name, "ProtocolError");
    assert(
      String((rejected as { message?: string }).message).includes(
        "serverPrimaryExecutionDocSetWatchV1",
      ),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

Deno.test("the client remove handler is monotonic: a stale remove never evicts a newer instance (FA8)", () => {
  const view = MemoryClient.WatchView.fromSync({
    type: "sync",
    fromSeq: 0,
    toSeq: 5,
    upserts: [{ branch: "", id: "of:x", seq: 5, doc: { value: "current" } }],
    removes: [],
  });
  // A reordered/stale remove frame whose watermark is BELOW the stored seq
  // must not wipe the newer value.
  view.applySync({
    type: "sync",
    fromSeq: 2,
    toSeq: 3,
    upserts: [],
    removes: [{ branch: "", id: "of:x" }],
  }, false);
  assertEquals(view.entities.map(idDoc), [
    { id: "of:x", document: { value: "current" } },
  ]);
  // A remove whose watermark is at or past the stored seq evicts as usual.
  view.applySync({
    type: "sync",
    fromSeq: 5,
    toSeq: 6,
    upserts: [],
    removes: [{ branch: "", id: "of:x" }],
  }, false);
  assertEquals(view.entities, []);
});

Deno.test("an inbound resolved scope key on a doc-set address is a protocol error (FA2)", async () => {
  const space = "did:key:z6Mk-docset-rawkey";
  const server = createServer("memory-v2-docset-rawkey");
  const client = await connectClient(server);
  try {
    const session = await mountAs(client, space, SPONSOR);
    let rejected: unknown;
    try {
      await session.watchSet([
        {
          id: "a",
          kind: "docs",
          docs: [{ id: "of:x", scopeKey: "user:forged" }],
        } as unknown as WatchSpec,
      ]);
    } catch (error) {
      rejected = error;
    }
    assertExists(rejected);
    assertEquals((rejected as { name?: string }).name, "ProtocolError");
  } finally {
    await client.close();
    await server.close();
  }
});

// --- FW3 (Fable review FB24): member registration must be atomic with watch
// installation. A watchAdd whose docs list fails scope resolution mid-way
// (user-scoped address on a principal-less session) must leave NO trace: no
// installed watch, no registered members — so a corrected retry with the same
// watch id succeeds instead of being rejected as a same-id respec (or, worse,
// vacuously succeeding against a half-installed watch that delivers nothing).

Deno.test("watchAdd atomicity: a failed docs registration leaves no trace and a corrected same-id retry succeeds (FB24)", async () => {
  const space = "did:key:z6Mk-docset-atomic";
  const server = createServer("memory-v2-docset-atomic");
  const writerClient = await connectClient(server);
  const watcherClient = await connectClient(server);
  try {
    const writer = await mountAs(writerClient, space, SPONSOR);
    // A principal-less session (authorizeSessionOpen returning undefined is a
    // supported configuration): a user-scoped member address cannot resolve a
    // scope key for it, so registration throws after of:x already staged.
    const watcher = await watcherClient.mount(
      space,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {},
      }),
    );

    let failed: unknown;
    try {
      await watcher.watchAdd([
        docsWatch("a", [{ id: "of:x" }, { id: "of:u", scope: "user" }]),
      ]);
    } catch (error) {
      failed = error;
    }
    assertExists(
      failed,
      "a user-scoped member on a principal-less session must fail",
    );

    await setDoc(writer, 1, "of:x", "X1");
    // No trace: the failed request registered nothing, so a resume finds no
    // watch surface and no member owing a delta. (Before the fix the watch
    // was installed and of:x registered, so this resume delivered X1.)
    const resumed = await server.syncSessionForConnection(
      space,
      watcher.sessionId,
    );
    assertEquals(
      resumed,
      null,
      "a failed registration must not leave members that deliver",
    );

    // A corrected retry with the SAME watch id succeeds (before the fix it
    // was rejected as a same-id respec of the half-installed watch).
    const view = await watcher.watchAdd([docsWatch("a", [{ id: "of:x" }])]);
    assertEquals(view.entities.map(idDoc), [
      { id: "of:x", document: { value: "X1" } },
    ]);

    // ... and the corrected watch delivers.
    const next = view.subscribe().next();
    await setDoc(writer, 2, "of:x", "X2");
    await next;
    assertEquals(view.entities.map(idDoc), [
      { id: "of:x", document: { value: "X2" } },
    ]);
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});

// --- FW3 (Fable review FB23): the FA8 member-set-size gauge must be live.
// docSetMembersTracked is exported end-to-end (/api/health/stats reads
// feedStats verbatim), so a permanently-zero value hides exactly the
// stale-membership growth the gauge exists to catch.

Deno.test("the docSetMembersTracked gauge tracks live membership across sessions and shrinks with it (FB23)", async () => {
  const space = "did:key:z6Mk-docset-gauge";
  const server = createServer("memory-v2-docset-gauge");
  const aClient = await connectClient(server);
  const bClient = await connectClient(server);
  try {
    const a = await mountAs(aClient, space, SPONSOR);
    const b = await mountAs(bClient, space, SPONSOR);

    await a.watchSet([docsWatch("a", [{ id: "of:x" }, { id: "of:y" }])]);
    // Member-set size summed ACROSS sessions: the same doc in two sessions
    // counts once per session (each session point-reads it independently).
    await b.watchSet([docsWatch("b", [{ id: "of:y" }])]);
    assertEquals(server.feedStats.docSetMembersTracked, 3);

    // A same-id shrink drops the gauge with the membership (FA8/FB6).
    await a.watchSetSync([docsWatch("a", [{ id: "of:x" }])]);
    assertEquals(server.feedStats.docSetMembersTracked, 2);

    // Replacing a session's watch set with nothing empties its contribution.
    await b.watchSetSync([]);
    assertEquals(server.feedStats.docSetMembersTracked, 1);
  } finally {
    await aClient.close();
    await bClient.close();
    await server.close();
  }
});

// --- FW1 (Fable review FB1): the F4b demotion against the REAL server. A doc
// that moves from graph tracking to doc-set membership must survive the
// demoting watch.set — delivered once, in one frame, under one watermark
// (FA3) — while a doc that genuinely leaves the whole watch surface is still
// removed. Before the FW1 fix the demoting frame carried removes for the
// entire previously graph-tracked closure and the client evicted every held
// doc (the pull → demote → evict livelock).

// --- FW3 (Fable review FB6): FA8 shrink for a same-id `watch.set`
// replacement. The protocol directs same-id respec to session.watch.set, so a
// narrowed docs list under a SURVIVING watch id must drop its member
// contribution: members absent from the new docs list lose that watch's
// source, and a member whose last source drops is evicted — while a surviving
// member keeps its lastSentSeq (FA15: replacement is never a reseed).

Deno.test("FA8 shrink: a narrowed same-id watch.set stops delivering dropped members; survivors keep lastSentSeq (FB6)", async () => {
  const space = "did:key:z6Mk-docset-shrink";
  const server = createServer("memory-v2-docset-shrink");
  const writerClient = await connectClient(server);
  const agedClient = await connectClient(server);
  const freshClient = await connectClient(server);
  const canaryClient = await connectClient(server);
  try {
    const writer = await mountAs(writerClient, space, SPONSOR);
    const aged = await mountAs(agedClient, space, SPONSOR);

    // The aged session watches both docs under ONE watch id.
    const agedView = await aged.watchSet([
      docsWatch("a", [{ id: "of:x" }, { id: "of:y" }]),
    ]);
    const agedFirst = agedView.subscribe().next();
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:x", value: { value: "X1" } },
        { op: "set", id: "of:y", value: { value: "Y1" } },
      ],
    });
    await agedFirst;
    assertEquals(
      agedView.entities.map(idDoc).toSorted((l, r) => l.id.localeCompare(r.id)),
      [
        { id: "of:x", document: { value: "X1" } },
        { id: "of:y", document: { value: "Y1" } },
      ],
    );

    // Same-id narrowing replacement — the exact shape the watchAdd same-id
    // error directs clients to ("use session.watch.set").
    const shrunk = await aged.watchSetSync([docsWatch("a", [{ id: "of:x" }])]);
    // FA15: the surviving member is NOT re-seeded — its lastSentSeq survived
    // the replace, so the registration frame carries no fresh snapshot.
    assertEquals(shrunk.sync.upserts, []);
    // FA8: membership shrink never emits SessionSync.removes.
    assertEquals(shrunk.sync.removes, []);

    // Fresh twin — the FA8 acceptance comparator ("an aged session's member
    // set equals a fresh session's for the same UI"): same watch set,
    // registered from scratch.
    const fresh = await mountAs(freshClient, space, SPONSOR);
    const freshView = await fresh.watchSet([docsWatch("a", [{ id: "of:x" }])]);
    assertEquals(freshView.entities.map(idDoc), [
      { id: "of:x", document: { value: "X1" } },
    ]);

    // Canary session watches of:y. Its connection registered AFTER the aged
    // session's, and wave fan-out walks connections in registration order,
    // so its delivery is the barrier proving the aged session's connection
    // was already served for the same wave.
    const canary = await mountAs(canaryClient, space, SPONSOR);
    const canaryView = await canary.watchSet([
      docsWatch("c", [{ id: "of:y" }]),
    ]);
    const canaryNext = canaryView.subscribe().next();

    const deliveriesBefore = server.feedStats.docSetMemberDeliveries;
    await setDoc(writer, 2, "of:y", "Y2");
    await canaryNext;
    // The dropped member produced NO delivery to the aged session: of:y is
    // gone from its member set. (The client keeps the last value Y1 — F4
    // owns client-side eviction; the server just stops delivering.)
    assertEquals(
      agedView.entities.map(idDoc).toSorted((l, r) => l.id.localeCompare(r.id)),
      [
        { id: "of:x", document: { value: "X1" } },
        { id: "of:y", document: { value: "Y1" } },
      ],
    );
    // Exactly one member delivery crossed the wire for this wave: the
    // canary's. Before the fix the aged session also received Y2 (+2).
    assertEquals(server.feedStats.docSetMemberDeliveries, deliveriesBefore + 1);

    // The surviving member still delivers to BOTH the aged session and its
    // fresh twin — identical deltas (the behavioral aged==fresh acceptance).
    const agedNext = agedView.subscribe().next();
    const freshNext = freshView.subscribe().next();
    await setDoc(writer, 3, "of:x", "X2");
    await agedNext;
    await freshNext;
    assertEquals(
      agedView.entities.map(idDoc).toSorted((l, r) => l.id.localeCompare(r.id)),
      [
        { id: "of:x", document: { value: "X2" } },
        { id: "of:y", document: { value: "Y1" } },
      ],
    );
    assertEquals(freshView.entities.map(idDoc), [
      { id: "of:x", document: { value: "X2" } },
    ]);
    // FA8 aged==fresh acceptance, structural form: with the member gauge live
    // (FB23), the server tracks exactly aged{of:x} + fresh{of:x} +
    // canary{of:y} — the aged session's member set equals its fresh twin's.
    assertEquals(server.feedStats.docSetMembersTracked, 3);
  } finally {
    await writerClient.close();
    await agedClient.close();
    await freshClient.close();
    await canaryClient.close();
    await server.close();
  }
});

Deno.test("F4b demotion: graph-tracked docs that become members survive the demoting watch.set; docs leaving the surface are removed (FB1)", async () => {
  const space = "did:key:z6Mk-docset-demote";
  const server = createServer("memory-v2-docset-demote");
  const writerClient = await connectClient(server);
  const watcherClient = await connectClient(server);
  try {
    const writer = await mountAs(writerClient, space, SPONSOR);
    const watcher = await mountAs(watcherClient, space, SPONSOR);

    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:root", value: { value: "R1" } },
        { op: "set", id: "of:child", value: { value: "C1" } },
      ],
    });

    // Cold boot: a subscribing graph watch holds the two-doc closure.
    const view = await watcher.watchSet([
      {
        id: "boot",
        kind: "graph",
        query: {
          roots: [
            { id: "of:root", selector: { path: [], schema: false } },
            { id: "of:child", selector: { path: [], schema: false } },
          ],
        },
      } as unknown as WatchSpec,
    ]);
    assertEquals(
      view.entities.map(idDoc).toSorted((l, r) => l.id.localeCompare(r.id)),
      [
        { id: "of:child", document: { value: "C1" } },
        { id: "of:root", document: { value: "R1" } },
      ],
    );

    // F4b demotion: replace the graph watch with doc-set membership over
    // PART of the held closure — of:root becomes a member, of:child leaves
    // the watch surface entirely.
    const demotion = await watcher.watchSetSync([
      docsWatch("m", [{ id: "of:root" }]),
    ]);

    // The member is not removed by its own demotion frame; the departing
    // doc is (a genuine surface shrink, the control).
    assertEquals(
      demotion.sync.removes.map((remove) => remove.id),
      ["of:child"],
    );
    // The held member survives in the client view with its value intact.
    assertEquals(view.entities.map(idDoc), [
      { id: "of:root", document: { value: "R1" } },
    ]);

    // Steady state is reached: the demoted surface still serves — a later
    // commit reaches the member through membership fan-out, not a re-pull.
    const next = view.subscribe().next();
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: "of:root", value: { value: "R2" } }],
    });
    await next;
    assertEquals(view.entities.map(idDoc), [
      { id: "of:root", document: { value: "R2" } },
    ]);
  } finally {
    await writerClient.close();
    await watcherClient.close();
    await server.close();
  }
});

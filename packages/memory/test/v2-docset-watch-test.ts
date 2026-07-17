import { assert, assertEquals, assertExists } from "@std/assert";
import * as MemoryClient from "../v2/client.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import type { EntitySnapshot, WatchSpec } from "../v2.ts";

// --- F3 doc-set watch kind: additive WatchSpec, absent-false subcapability,
// server membership fan-out via per-wave point reads. ---

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

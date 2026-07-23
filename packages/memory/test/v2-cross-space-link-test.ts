// C3.10a — the co-hosted link substrate: link-layer mechanics over the
// serializing in-memory duplex and the WebSocket medium.
//
// Fixture map (plan row C3.10a; amendments C3A1/C3A8/C3A13):
//  (a) the C3.1 conformance harness — the row's core acceptance — runs
//      UNCHANGED over the co-hosted transport: two hosts, two routers,
//      one multiplexed link, both over the in-memory serializing duplex
//      AND over a real WebSocket on 127.0.0.1 (`Deno.serve`, the
//      standalone.ts pattern) — the latter is the "deployable over TCP
//      localhost without redesign" proof;
//  (b) the inherited C3A1 discrimination still reds over this
//      transport: the direct-call bypass fails the harness;
//  (c) the C3A13 link-identity-to-stamp binding: a frame whose
//      `fromSpace` is outside the peer's declared set DROPS at the
//      link gate — counted, warned, ZERO deliveries (the green twin
//      with a declared fromSpace delivers) — and a frame for an
//      unhosted `toSpace` that passes the gate still drops at the
//      router with no registration (the C3.1b discipline composing);
//  (d) hello negotiation: refusals (version-mismatch, self-link,
//      duplicate-link, space-conflict, payload-before-hello), the
//      derived stable linkId, and the hosted-spaces UPDATE (full-set
//      redeclaration: adopt, supersede, conflicting-claim drop);
//  (e) medium honesty: only strings cross the duplex (a non-string
//      send throws), delivery is asynchronous, per-link FIFO holds
//      across control and payload frames;
//  (f) lifecycle: socket loss closes the link — routes retire, the
//      channel reports closed, lifecycle observers hear `closed`
//      (reconnect/resync drills are C3.10b's, dated 2026-07-18);
//  (g) module boundary: cross-space-link.ts imports ONLY
//      ./cross-space.ts (the C3.1 boundary discipline extended).
//
// Barrier-driven throughout: every await is an `opened` promise, an
// inbox waitFor, or the pair's quiescence barrier — no sleeps.
import {
  assert,
  assertEquals,
  AssertionError,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  CROSS_SPACE_PROTOCOL_VERSION,
  CrossSpaceHostRouter,
  type CrossSpaceMessage,
  CrossSpaceProtocolError,
  encodeCrossSpaceMessage,
  type ForeignDirtyMark,
} from "../v2/cross-space.ts";
import {
  type CoHostedCrossSpaceLink,
  CoHostedCrossSpaceTransport,
  type CrossSpaceLinkSocket,
  crossSpaceLinkSocketPair,
  webSocketCrossSpaceLinkSocket,
} from "../v2/cross-space-link.ts";
import {
  type CrossSpaceExchangeFixture,
  HARNESS_HOME_SPACE,
  HARNESS_READ_SPACE,
  runCrossSpaceExchangeConformance,
} from "./v2-cross-space-harness.ts";

const HOST_A = "host:xsp-link-a";
const HOST_B = "host:xsp-link-b";
const SPACE_A = "did:key:z6Mk-xsp-link-space-a";
const SPACE_B = "did:key:z6Mk-xsp-link-space-b";
const SPACE_B2 = "did:key:z6Mk-xsp-link-space-b2";

const EXPECTED_LINK_ID = (a: string, b: string): string =>
  `xsp:link:${JSON.stringify([a, b].sort())}`;

/** A minimal valid dirty-mark body for crafting raw frames. */
const dirtyMarkInit = {
  type: "foreign-dirty-mark" as const,
  branch: "",
  dirtySeq: 1,
  readers: [],
};

const rawDirtyMark = (
  linkId: string,
  fromSpace: string,
  toSpace: string,
): string =>
  encodeCrossSpaceMessage({
    ...dirtyMarkInit,
    v: CROSS_SPACE_PROTOCOL_VERSION,
    linkId,
    fromSpace,
    toSpace,
  } as ForeignDirtyMark);

/** Drive one side of a pair as a RAW peer (no transport): record every
 * frame the transport under test sends, send crafted frames back. */
const rawPeer = (socket: CrossSpaceLinkSocket) => {
  const frames: string[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }[] = [];
  const parsedFrames = (): Record<string, unknown>[] =>
    frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  socket.onFrame((frame) => {
    frames.push(frame);
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(parsed)) {
        const [waiter] = waiters.splice(i, 1);
        waiter.resolve(parsed);
      }
    }
  });
  return {
    frames,
    parsedFrames,
    waitFor: (
      predicate: (frame: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> => {
      const existing = parsedFrames().find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    hello: (
      hostId: string,
      hostedSpaces: readonly string[],
      protocolVersion = CROSS_SPACE_PROTOCOL_VERSION,
    ) =>
      socket.send(JSON.stringify({
        link: "hello",
        hostId,
        protocolVersion,
        hostedSpaces,
      })),
    spaces: (hostedSpaces: readonly string[]) =>
      socket.send(JSON.stringify({ link: "spaces", hostedSpaces })),
    send: (frame: string) => socket.send(frame),
  };
};

// ---------------------------------------------------------------------------
// (a) + (b): the C3.1 conformance harness over the co-hosted transport.
// ---------------------------------------------------------------------------

/** Two hosts, two bare routers, one link over the given sockets — the
 * co-hosted realization of the harness fixture (its docblock's
 * "C3.10a's fixture wraps two linked" hosts). */
const coHostedExchangeFixture = async (
  sockets: readonly [CrossSpaceLinkSocket, CrossSpaceLinkSocket],
  onClose?: () => Promise<void> | void,
): Promise<CrossSpaceExchangeFixture> => {
  const homeTransport = new CoHostedCrossSpaceTransport({
    hostId: "host:xsp-conf-home",
    hostedSpaces: [HARNESS_HOME_SPACE],
  });
  const readTransport = new CoHostedCrossSpaceTransport({
    hostId: "host:xsp-conf-read",
    hostedSpaces: [HARNESS_READ_SPACE],
  });
  const homeRouter = new CrossSpaceHostRouter(homeTransport);
  const readRouter = new CrossSpaceHostRouter(readTransport);
  const homeLink = homeTransport.attachLink(sockets[0]);
  const readLink = readTransport.attachLink(sockets[1]);
  await Promise.all([homeLink.opened, readLink.opened]);
  return {
    ordering: homeTransport.ordering,
    homeSpace: HARNESS_HOME_SPACE,
    readSpace: HARNESS_READ_SPACE,
    registerHome: (handler) => {
      const registration = homeRouter.register(HARNESS_HOME_SPACE, handler);
      return () => registration.close();
    },
    registerRead: (handler) => {
      const registration = readRouter.register(HARNESS_READ_SPACE, handler);
      return () => registration.close();
    },
    homeEndpoint: () => homeRouter.link(HARNESS_HOME_SPACE, HARNESS_READ_SPACE),
    readEndpoint: () => readRouter.link(HARNESS_READ_SPACE, HARNESS_HOME_SPACE),
    close: async () => {
      homeRouter.close();
      readRouter.close();
      await onClose?.();
    },
  };
};

Deno.test("C3.10a conformance: the C3.1 harness passes as-is over two hosts linked by the serializing duplex", async () => {
  const transcript = await runCrossSpaceExchangeConformance(() =>
    coHostedExchangeFixture(crossSpaceLinkSocketPair().sockets)
  );
  // The whole exchange rode the ONE multiplexed link with the derived
  // stable identity — the C3A12/C3A13 keying substrate.
  const expected = EXPECTED_LINK_ID("host:xsp-conf-home", "host:xsp-conf-read");
  for (const message of [...transcript.atRead, ...transcript.atHome]) {
    assertEquals(message.linkId, expected);
  }
});

Deno.test("C3.10a discrimination (inherited C3A1): the direct-call bypass still reds the harness over the co-hosted link", async () => {
  await assertRejects(
    () =>
      runCrossSpaceExchangeConformance(
        () => coHostedExchangeFixture(crossSpaceLinkSocketPair().sockets),
        { pointReadDelivery: "direct-call" },
      ),
    AssertionError,
    "via the transport",
  );
});

Deno.test("C3.10a deployability: the harness passes over a real WebSocket on 127.0.0.1 (Deno.serve — the standalone.ts pattern)", async () => {
  // Loopback TCP WebSocket pair: the deployment medium of the co-hosted
  // assumption set, no redesign — the link sockets are the adapter over
  // real sockets.
  const serverSocketReady = Promise.withResolvers<WebSocket>();
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.addEventListener(
        "open",
        () => serverSocketReady.resolve(socket),
      );
      return response;
    },
  );
  const address = http.addr as Deno.NetAddr;
  const clientSocket = new WebSocket(`ws://127.0.0.1:${address.port}/`);
  await new Promise<void>((resolve, reject) => {
    clientSocket.addEventListener("open", () => resolve());
    clientSocket.addEventListener(
      "error",
      () => reject(new Error("client websocket failed to open")),
    );
  });
  const serverSocket = await serverSocketReady.promise;
  const closed = (socket: WebSocket): Promise<void> =>
    socket.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : new Promise((resolve) =>
        socket.addEventListener("close", () => resolve())
      );
  const transcript = await runCrossSpaceExchangeConformance(() =>
    coHostedExchangeFixture(
      [
        webSocketCrossSpaceLinkSocket(clientSocket),
        webSocketCrossSpaceLinkSocket(serverSocket),
      ],
      async () => {
        await Promise.all([closed(clientSocket), closed(serverSocket)]);
        await http.shutdown();
      },
    )
  );
  assertEquals(transcript.atRead.length, 3);
  assertEquals(transcript.atHome.length, 2);
});

// ---------------------------------------------------------------------------
// (c) The C3A13 gate at the link layer.
// ---------------------------------------------------------------------------

Deno.test("C3A13 binding: a frame with fromSpace outside the peer's declared set drops at the link gate — counter up, zero deliveries; the declared twin delivers", async () => {
  const pair = crossSpaceLinkSocketPair();
  const transport = new CoHostedCrossSpaceTransport({
    hostId: HOST_A,
    hostedSpaces: [SPACE_A],
  });
  const router = new CrossSpaceHostRouter(transport);
  const inbox: CrossSpaceMessage[] = [];
  router.register(SPACE_A, (message) => {
    inbox.push(message);
  });
  const link = transport.attachLink(pair.sockets[0]);
  const peer = rawPeer(pair.sockets[1]);
  peer.hello(HOST_B, [SPACE_B]);
  const bound = await link.opened;
  assertEquals(bound.peerHostId, HOST_B);
  assertEquals(bound.linkId, EXPECTED_LINK_ID(HOST_A, HOST_B));
  assertEquals(link.peerHostedSpaces(), [SPACE_B]);

  // Tap the LINK CHANNEL itself: the gate must drop BEFORE any channel
  // handler — zero deliveries is the zero-side-effect evidence at this
  // layer (the router, and any engine behind it, never hears the frame).
  const delivered: string[] = [];
  transport.channelTo(SPACE_B).onMessage((wire) => delivered.push(wire));

  // Forged: B's link speaking for a space B never declared.
  peer.send(
    rawDirtyMark(bound.linkId, "did:key:z6Mk-evil-undeclared", SPACE_A),
  );
  await pair.whenQuiet();
  assertEquals(link.diagnostics().fromSpaceViolationsDropped, 1);
  assertEquals(link.diagnostics().framesDelivered, 0);
  assertEquals(delivered.length, 0, "the gate drops before channel handlers");
  assertEquals(inbox.length, 0);

  // Green twin — byte-identical except the fromSpace stamp is one the
  // link is bound to: delivers to the registered inbox.
  peer.send(rawDirtyMark(bound.linkId, SPACE_B, SPACE_A));
  await pair.whenQuiet();
  assertEquals(link.diagnostics().fromSpaceViolationsDropped, 1);
  assertEquals(link.diagnostics().framesDelivered, 1);
  assertEquals(delivered.length, 1);
  assertEquals(inbox.length, 1);
  assertEquals(inbox[0].type, "foreign-dirty-mark");
  assertEquals(inbox[0].fromSpace, SPACE_B);

  // Composition with the router discipline: a declared fromSpace but an
  // unhosted toSpace passes the gate and drops AT THE ROUTER — no
  // registration, no inbox delivery (the C3.1b zero-side-effect drop).
  peer.send(rawDirtyMark(bound.linkId, SPACE_B, "did:key:z6Mk-unhosted"));
  await pair.whenQuiet();
  assertEquals(link.diagnostics().framesDelivered, 2);
  assertEquals(inbox.length, 1, "no inbox observed the unhosted-toSpace frame");
  assert(!router.isHosted("did:key:z6Mk-unhosted"));
  assertEquals(router.hostedSpaces(), [SPACE_A]);

  router.close();
});

// ---------------------------------------------------------------------------
// (d) Hello negotiation + the hosted-spaces update.
// ---------------------------------------------------------------------------

const attachRawLink = (
  options: { hostedSpaces?: readonly string[] } = {},
): {
  transport: CoHostedCrossSpaceTransport;
  link: CoHostedCrossSpaceLink;
  peer: ReturnType<typeof rawPeer>;
  pair: ReturnType<typeof crossSpaceLinkSocketPair>;
} => {
  const pair = crossSpaceLinkSocketPair();
  const transport = new CoHostedCrossSpaceTransport({
    hostId: HOST_A,
    hostedSpaces: options.hostedSpaces ?? [SPACE_A],
  });
  const link = transport.attachLink(pair.sockets[0]);
  const peer = rawPeer(pair.sockets[1]);
  return { transport, link, peer, pair };
};

Deno.test("C3.10a hello: refusals — version mismatch, self-link, space conflict, duplicate link, payload before hello — send hello-refused and reject opened", async (t) => {
  const expectRefusal = async (
    link: CoHostedCrossSpaceLink,
    peer: ReturnType<typeof rawPeer>,
    reason: string,
  ): Promise<void> => {
    await assertRejects(() => link.opened, CrossSpaceProtocolError);
    const refusal = await peer.waitFor(
      (frame) => frame.link === "hello-refused",
    );
    assertEquals(refusal.reason, reason);
    assertEquals(link.state, "closed");
  };

  await t.step("version mismatch", async () => {
    const { transport, link, peer } = attachRawLink();
    peer.hello(HOST_B, [SPACE_B], CROSS_SPACE_PROTOCOL_VERSION + 1);
    await expectRefusal(link, peer, "version-mismatch");
    transport.close();
  });

  await t.step("self-link (peer claims this host's own id)", async () => {
    const { transport, link, peer } = attachRawLink();
    peer.hello(HOST_A, [SPACE_B]);
    await expectRefusal(link, peer, "self-link");
    transport.close();
  });

  await t.step(
    "space conflict (peer declares a locally-hosted space)",
    async () => {
      const { transport, link, peer } = attachRawLink();
      peer.hello(HOST_B, [SPACE_B, SPACE_A]);
      await expectRefusal(link, peer, "space-conflict");
      transport.close();
    },
  );

  await t.step("duplicate link for a live peer host id", async () => {
    const { transport, link, peer } = attachRawLink();
    peer.hello(HOST_B, [SPACE_B]);
    await link.opened;
    const secondPair = crossSpaceLinkSocketPair();
    const secondLink = transport.attachLink(secondPair.sockets[0]);
    const secondPeer = rawPeer(secondPair.sockets[1]);
    secondPeer.hello(HOST_B, [SPACE_B2]);
    await expectRefusal(secondLink, secondPeer, "duplicate-link");
    // The live link is untouched, and the refused link adopted nothing.
    assertEquals(link.state, "open");
    assertEquals(transport.routing.peerHostFor(SPACE_B), HOST_B);
    assertEquals(transport.routing.peerHostFor(SPACE_B2), undefined);
    transport.close();
  });

  await t.step("payload frame before hello", async () => {
    const { transport, link, peer } = attachRawLink();
    peer.send(rawDirtyMark("xsp:link:premature", SPACE_B, SPACE_A));
    await expectRefusal(link, peer, "protocol-violation");
    transport.close();
  });
});

Deno.test("C3.10a hosted-spaces update: full-set redeclaration adopts, supersedes, and drops conflicting claims with a counter", async () => {
  const { transport, link, peer, pair } = attachRawLink();
  peer.hello(HOST_B, [SPACE_B]);
  const bound = await link.opened;
  assertEquals(transport.routing.routedSpaces(), [SPACE_B]);

  // Adopt: the peer starts serving SPACE_B2 — frames from it now pass
  // the C3A13 gate.
  peer.spaces([SPACE_B, SPACE_B2]);
  await pair.whenQuiet();
  assertEquals(transport.routing.peerHostFor(SPACE_B2), HOST_B);
  peer.send(rawDirtyMark(bound.linkId, SPACE_B2, SPACE_A));
  await pair.whenQuiet();
  assertEquals(link.diagnostics().framesDelivered, 1);

  // Supersede: a later full set WITHOUT SPACE_B2 retires its route and
  // its stamp authority (the C3A13 set follows the declaration).
  peer.spaces([SPACE_B]);
  await pair.whenQuiet();
  assertEquals(transport.routing.peerHostFor(SPACE_B2), undefined);
  peer.send(rawDirtyMark(bound.linkId, SPACE_B2, SPACE_A));
  await pair.whenQuiet();
  assertEquals(link.diagnostics().fromSpaceViolationsDropped, 1);

  // Conflicting claim: a declaration naming a locally-hosted space is
  // dropped (counted) — the peer gains no route and NO stamp authority
  // for it — while the rest of the set still applies.
  peer.spaces([SPACE_B, SPACE_A]);
  await pair.whenQuiet();
  assertEquals(link.diagnostics().conflictingClaimsDropped, 1);
  assertEquals(transport.routing.peerHostFor(SPACE_A), undefined);
  assertEquals(transport.routing.peerHostFor(SPACE_B), HOST_B);
  peer.send(rawDirtyMark(bound.linkId, SPACE_A, SPACE_B));
  await pair.whenQuiet();
  assertEquals(
    link.diagnostics().fromSpaceViolationsDropped,
    2,
    "a conflicted claim never grants stamp authority for our own space",
  );

  transport.close();
});

Deno.test("C3.10a declarations: local registrations ride the spaces update FIFO-before any frame from the new space", async () => {
  const pair = crossSpaceLinkSocketPair();
  const transport = new CoHostedCrossSpaceTransport({
    hostId: HOST_A,
    hostedSpaces: [SPACE_A],
  });
  const router = new CrossSpaceHostRouter(transport);
  const link = transport.attachLink(pair.sockets[0]);
  const peer = rawPeer(pair.sockets[1]);
  peer.hello(HOST_B, [SPACE_B]);
  await link.opened;
  const hello = await peer.waitFor((frame) => frame.link === "hello");
  assertEquals(hello.hostedSpaces, [SPACE_A]);

  // Registering a fresh local space declares it to the peer, and the
  // declaration precedes the first payload frame from that space on
  // the FIFO link (declare-before-speak).
  const FRESH = "did:key:z6Mk-xsp-link-fresh";
  router.register(FRESH, () => {});
  router.link(FRESH, SPACE_B).send(dirtyMarkInit);
  await pair.whenQuiet();
  const types = peer.parsedFrames().map((frame) =>
    typeof frame.link === "string" ? `link:${frame.link}` : `xsp:${frame.type}`
  );
  const declarationIndex = types.lastIndexOf("link:spaces");
  const payloadIndex = types.indexOf("xsp:foreign-dirty-mark");
  assert(declarationIndex !== -1, "the registration was declared");
  assert(payloadIndex !== -1, "the payload frame was sent");
  assert(
    declarationIndex < payloadIndex,
    "declare-before-speak: the spaces update precedes the frame",
  );
  const declaration = peer.parsedFrames()[declarationIndex];
  assertEquals(
    declaration.hostedSpaces,
    [SPACE_A, FRESH].sort(),
    "full-set redeclaration",
  );
  router.close();
});

// ---------------------------------------------------------------------------
// (e) Medium honesty.
// ---------------------------------------------------------------------------

Deno.test("C3.10a medium: the duplex carries only strings, delivers asynchronously, and preserves FIFO across control and payload", async () => {
  const pair = crossSpaceLinkSocketPair();
  // Only strings cross — structured values are rejected AT THE MEDIUM,
  // so the C3.1 codec is load-bearing for everything on the link.
  assertThrows(
    () =>
      (pair.sockets[0].send as unknown as (frame: unknown) => void)({
        object: true,
      }),
    TypeError,
    "TEXT FRAMES",
  );
  // Asynchronous delivery: the process-shaped boundary — a send returns
  // before any handler observes the frame.
  const seen: string[] = [];
  pair.sockets[1].onFrame((frame) => seen.push(frame));
  pair.sockets[0].send("first");
  pair.sockets[0].send("second");
  assertEquals(seen, [], "no synchronous delivery");
  await pair.whenQuiet();
  assertEquals(seen, ["first", "second"], "FIFO in send order");
  assertEquals(pair.framesTransferred(), 2);
  pair.sockets[0].close();
  await pair.whenQuiet();
});

// ---------------------------------------------------------------------------
// (f) Lifecycle.
// ---------------------------------------------------------------------------

Deno.test("C3.10a lifecycle: socket loss closes the link — routes retire, channel closes, lifecycle observers hear closed (reconnect is C3.10b's)", async () => {
  const { transport, link, peer, pair } = attachRawLink();
  peer.hello(HOST_B, [SPACE_B]);
  await link.opened;
  const channel = transport.channelTo(SPACE_B);
  assertEquals(channel.state, "open");
  assertEquals(channel.incarnation, 1, "one attach = one incarnation");
  const lifecycle: string[] = [];
  channel.onLifecycle((event) => lifecycle.push(event.kind));

  pair.sockets[1].close();
  await pair.whenQuiet();
  assertEquals(link.state, "closed");
  assertEquals(lifecycle, ["closed"]);
  assertEquals(
    transport.routing.peerHostFor(SPACE_B),
    undefined,
    "routes retire with the link",
  );
  // Sends now throw the link-closed discipline (matching in-process).
  assertThrows(
    () => channel.send("{}"),
    CrossSpaceProtocolError,
    "not open",
  );
  // channelTo for the formerly-routed space falls back to the loopback
  // drop discipline rather than resurrecting the dead link.
  assert(transport.channelTo(SPACE_B).linkId !== channel.linkId);
  transport.close();
});

Deno.test("C3.10b reconnect: a new socket for a closed peer rebinds the SAME channel — `reconnected` fires, incarnation bumps, linkId is stable, delivery resumes", async () => {
  const { transport, link, peer, pair } = attachRawLink();
  peer.hello(HOST_B, [SPACE_B]);
  await link.opened;
  // Capture the PERSISTED channel and its subscriptions BEFORE the loss — the
  // reconnect must rebind this exact object so router/server subscriptions
  // survive.
  const channel = transport.channelTo(SPACE_B);
  const originalLinkId = channel.linkId;
  const lifecycle: string[] = [];
  channel.onLifecycle((event) => lifecycle.push(event.kind));
  const delivered: string[] = [];
  channel.onMessage((wire) => delivered.push(wire));

  // Lose the link.
  pair.sockets[1].close();
  await pair.whenQuiet();
  assertEquals(lifecycle, ["closed"]);
  assertEquals(channel.state, "closed");

  // Reconnect: a fresh socket to the SAME transport + a fresh hello for the
  // same peer id. This is a reconnect (the prior incarnation closed), not a
  // duplicate.
  const pair2 = crossSpaceLinkSocketPair();
  const link2 = transport.attachLink(pair2.sockets[0]);
  const peer2 = rawPeer(pair2.sockets[1]);
  peer2.hello(HOST_B, [SPACE_B]);
  await link2.opened;
  await pair2.whenQuiet();

  assertEquals(lifecycle, ["closed", "reconnected"], "reconnected fired");
  assertEquals(channel.state, "open", "the persisted channel reopened");
  assertEquals(channel.incarnation, 2, "incarnation bumped on reconnect");
  assertEquals(channel.linkId, originalLinkId, "linkId is stable (C3A12 keys)");
  assertEquals(
    transport.channelTo(SPACE_B).linkId,
    originalLinkId,
    "the route re-adopted the reconnected link",
  );

  // Delivery resumes on the SAME subscription: a payload from the peer over
  // the new incarnation reaches the onMessage handler registered pre-loss.
  peer2.send(rawDirtyMark(originalLinkId, SPACE_B, SPACE_A));
  await pair2.whenQuiet();
  assertEquals(delivered.length, 1, "a frame delivered over the reconnection");
  transport.close();
});

Deno.test("C3.10b reconnect: a LIVE duplicate still refuses — a reconnect only rebinds a CLOSED incarnation", async () => {
  const { transport, link, peer } = attachRawLink();
  peer.hello(HOST_B, [SPACE_B]);
  await link.opened;
  assertEquals(transport.channelTo(SPACE_B).incarnation, 1);

  // A second attach for the SAME (still-live) peer id is a duplicate, not a
  // reconnect — its `opened` rejects and the live channel is untouched.
  const pair2 = crossSpaceLinkSocketPair();
  const dupLink = transport.attachLink(pair2.sockets[0]);
  const dupPeer = rawPeer(pair2.sockets[1]);
  dupPeer.hello(HOST_B, [SPACE_B]);
  await assertRejects(() => dupLink.opened, CrossSpaceProtocolError);
  assertEquals(
    transport.channelTo(SPACE_B).incarnation,
    1,
    "the live channel's incarnation is untouched by the refused duplicate",
  );
  assertEquals(transport.channelTo(SPACE_B).state, "open");
  transport.close();
});

// ---------------------------------------------------------------------------
// (g) Module boundary.
// ---------------------------------------------------------------------------

Deno.test("module boundary: cross-space-link.ts imports only the protocol module", async () => {
  const source = await Deno.readTextFile(
    new URL("../v2/cross-space-link.ts", import.meta.url),
  );
  const specifiers = [
    ...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gms),
  ].map((match) => match[1]);
  assert(specifiers.length > 0, "expected import statements");
  assertEquals(
    [...new Set(specifiers)],
    ["./cross-space.ts"],
    "cross-space-link.ts may import ONLY ./cross-space.ts — links carry " +
      "frames; hosts interpret them. If this fails you are moving the " +
      "protocol boundary: stop and re-read the C3.10a module docblock",
  );
  assert(
    !/\bimport\s*\(/.test(source),
    "no dynamic imports around the boundary either",
  );
});

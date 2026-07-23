import {
  CROSS_SPACE_PROTOCOL_VERSION,
  type CrossSpaceChannel,
  type CrossSpaceLinkLifecycleEvent,
  type CrossSpaceLinkState,
  type CrossSpaceOrderingCapability,
  CrossSpaceProtocolError,
  type CrossSpaceTransport,
  type CrossSpaceTransportRouting,
  InProcessCrossSpaceTransport,
} from "./cross-space.ts";

/**
 * Co-hosted cross-space link substrate (C3.10a, context-lattice §5).
 *
 * The C3.1 protocol's SECOND transport: real links between two `Server`
 * instances, with the space→host routing table and the link-identity
 * binding of C3A13. The in-process transport is one host talking to
 * itself; this module is host↔host — each host runs its own
 * {@link CoHostedCrossSpaceTransport}, links attach over a duplex
 * medium, a hello negotiation binds each link to its peer's identity
 * and declared hosted spaces, and every frame still round-trips the
 * C3.1 codec (the router encodes at send and parses at dispatch —
 * unchanged; this module never interprets payload frames beyond the
 * inbound gate below).
 *
 * **Co-hosted assumption set (§5, recorded here — where the link is
 * configured — per the C3.10a row):** the two hosts share deployment
 * locality; the link is LOW-LATENCY and RELIABLE with in-order
 * delivery (loopback TCP / an in-process duplex — not a WAN). This
 * transport does NOT provide partition tolerance, delivery retry, or
 * geo-distribution; a lost link simply closes (reconnect, cursor
 * resync, and link-loss claim revocation are C3.10b's, dated
 * 2026-07-18 — see "NOT built here" below). Geo-distributed hosts are
 * a LATER transport with its own design (gap-register row, C3.11).
 *
 * **Medium choice + deployability.** The link speaks single-line JSON
 * TEXT FRAMES over a {@link CrossSpaceLinkSocket} — deliberately the
 * exact surface a WebSocket provides (send text frame / message event
 * / close), following `standalone.ts`'s host pattern. Two media ship:
 *
 * - {@link crossSpaceLinkSocketPair} — an in-memory duplex that
 *   GENUINELY serializes: only strings cross (a non-string send
 *   throws), delivery is asynchronous FIFO, and no object identity
 *   survives the boundary — so two `Server` instances in one process
 *   exercise the full wire path (encode → frame string → gate → parse)
 *   with CI-friendly determinism, plus test seams (delivery hold,
 *   quiescence barrier) the repo's injectable-barrier fixtures need.
 * - {@link webSocketCrossSpaceLinkSocket} — the same frames over a
 *   real WebSocket. A conformance fixture runs the whole exchange over
 *   `Deno.serve` + WebSocket on 127.0.0.1, so "deployable over TCP
 *   localhost without redesign" is test-pinned, not asserted. (A raw
 *   TCP-stream deployment would add newline framing; frames are
 *   `JSON.stringify` output and thus newline-free by construction.)
 *
 * **Link protocol.** Frames are either LINK-CONTROL messages (a JSON
 * object with a string `link` discriminator — a field no C3.1 message
 * carries, and the codec's strict write means no payload frame can
 * ever smuggle one) or C3.1 PAYLOAD frames (passed through opaque).
 * Control vocabulary, v1:
 *
 * - `{link:"hello", hostId, protocolVersion, hostedSpaces}` — sent by
 *   BOTH sides at attach (symmetric; no dialer/listener asymmetry).
 *   `protocolVersion` is {@link CROSS_SPACE_PROTOCOL_VERSION}: the
 *   hello IS the link-negotiation seam the C3.1 versioning posture
 *   defers cross-version coexistence to — v1 refuses a non-v1 peer.
 *   `hostedSpaces` is the peer-declared set the C3A13 binding trusts.
 * - `{link:"hello-refused", reason, detail}` — sent before closing
 *   when a hello is refused (version-mismatch, self-link,
 *   duplicate-link, space-conflict, protocol-violation,
 *   malformed-frame), so the peer can diagnose; then the socket
 *   closes and `opened` rejects on both sides.
 * - `{link:"spaces", hostedSpaces}` — the hosted-spaces UPDATE: a
 *   FULL-SET redeclaration (not a delta), sent whenever the local
 *   hosted set grows (a host serving a new space). Full-set was chosen
 *   as the minimal update shape because it is idempotent and
 *   self-healing: on a FIFO link each update supersedes the last, so
 *   there is no add/remove delta ordering to reason about. Receipt
 *   reconciles the routing table (adopt new routes, retire routes for
 *   spaces no longer declared).
 *
 * Declare-before-speak ordering: a host can only send payload frames
 * for a registered local space (`CrossSpaceHostRouter.link` enforces
 * it), registration synchronously enqueues the `spaces` update on
 * every open link, and the medium is FIFO — so a peer always processes
 * the declaration before the first frame that relies on it.
 *
 * **Link identity + the C3A13 binding.** After both hellos, the link
 * binds:
 *
 * - `linkId` — DERIVED from the (sorted) host-id pair, identical on
 *   both sides and STABLE across reconnects, because C3A12 keys
 *   durable per-link state (the applied-dirt cursor, subscription
 *   state, epoch cache) by stable linkId. A per-connection random id
 *   would silently orphan those keys on every reconnect.
 * - `incarnation` — 1 at first open; C3.10b BUMPS it on each reconnect
 *   (a new socket attaching for a peer whose prior incarnation closed
 *   rebinds the SAME persisted channel, so the router/server
 *   subscriptions survive, and fires `reconnected`). Consumers drop
 *   dead-incarnation state by comparing it (C3A12). A LIVE duplicate
 *   still refuses `duplicate-link`.
 * - peer → declared spaces — THE C3A13 stamp-trust mechanism: a
 *   stamp's space claim is trusted BECAUSE the link it arrived on is
 *   bound to that host's identity for those spaces. Enforced at the
 *   inbound gate: a payload frame whose `fromSpace` is outside the
 *   peer's declared set DROPS before any handler sees it — zero side
 *   effects, counted ({@link CoHostedLinkDiagnostics}
 *   `fromSpaceViolationsDropped`), warned. So host X may only ever
 *   stamp spaces routed to X. Per-stamp SIGNATURES are the recorded
 *   gap-register deferral (C3A13 / C3.11) — deliberately NOT built.
 *
 * Identity-authentication posture (honest limit, 2026-07-18): the
 * hello's `hostId` is DECLARED, not cryptographically proven — v1
 * link trust is the deployment's socket wiring (the operator attaches
 * both ends over loopback, §5's same-locality assumption), mirroring
 * how `standalone.ts` hands its URL only to trusted runtimes. The
 * hello exchange reuses the standalone hello PATTERN (advertise →
 * validate → refuse-with-reason); a signed hello (the session-open
 * `verifySessionOpenAuthorization` machinery with a link challenge)
 * is the natural hardening slot when links leave single-operator
 * deployments — record alongside C3.10b's reconnect work. Per-stamp
 * signatures remain the separate gap-register row.
 *
 * **Routing table + the three-way split.** `channelTo(space)` resolves:
 * locally-hosted (configured ∪ registered) → the in-process loopback
 * (local spaces stay in-process); peer-routed → that peer's link
 * channel; unknown → the loopback, where the router's existing
 * unhosted-`toSpace` drop applies (zero side effects — the C3.1b
 * discipline, unchanged). The `Server` composes the same table into
 * its engine lifecycle: locally-hosted = register + create;
 * peer-routed = NEVER locally materialized (`openEngine` refuses,
 * loudly — C3A1); unknown = drop/refuse.
 *
 * Conflicting claims: a hello declaring a space this host already
 * hosts (configured or registered) REFUSES the link — split-brain
 * hosting is a deployment error and bring-up is the loud place to say
 * so. After open, drift is contained instead of fatal: an UPDATE
 * claiming a locally-hosted space (or a space another live link
 * already routes) drops THAT claim with a counter
 * (`conflictingClaimsDropped`) — and a dropped claim also stays out of
 * the peer's accepted set, so the peer cannot speak (or stamp) for a
 * space this host owns. One link per peer hostId: a second hello
 * under a live peer's id refuses `duplicate-link` (reconnect is
 * C3.10b's).
 *
 * **Ordering declaration (honest):** `perLinkFifo` — the media are
 * in-order (TCP / FIFO queue) and sends are enqueued in call order.
 * `receiveOrderFencing: true` — ALL cross-space traffic between a host
 * pair multiplexes on the ONE link (the routing table maps every
 * routed space of a peer to the same link), and an in-order medium
 * delivers the peer's emissions in its send (= commit) order relative
 * to every other frame on the link. `linkTopology:
 * "single-multiplexed-per-host-pair"` — declared AND structurally
 * true (one `LinkImpl` per peer, all routes point at it). Whether
 * C3.8's forced binary RELIES on the receive-order arm is C3.8's
 * ruling to record; C3.10b states the co-hosted half of C3A7 through
 * this same declaration (dated 2026-07-18).
 *
 * **Built by C3.10b (2026-07-18), on this substrate:** reconnect —
 * the incarnation bump + persisted-channel rebind above — so the home
 * host's `onLifecycle` `reconnected` drives its re-register / dirt
 * resync / epoch resync, and the `closed` event drives unilateral
 * dead-link claim revocation. The link module still only fires the
 * lifecycle events; the resync/revocation policy lives in the host
 * (server.ts), off these events.
 *
 * **NOT built here (dated pointers):**
 * - Gap register (C3.11): per-stamp signatures; the geo-distributed
 *   transport.
 * - Deployment endpoint wiring: mounting a link acceptor beside
 *   `standalone.ts`'s client endpoint (an HTTP route that upgrades and
 *   calls `attachLink`) belongs to the deployment that first co-hosts
 *   for real — the WebSocket conformance fixture demonstrates the
 *   shape.
 *
 * **Module boundary (enforced by test, like cross-space.ts):** this
 * module's only relative import is `./cross-space.ts`. It must never
 * import `./engine.ts`, `./server.ts`, or any host/engine internal —
 * links carry frames; hosts interpret them.
 */

// ---------------------------------------------------------------------------
// The socket seam.
// ---------------------------------------------------------------------------

/**
 * The duplex medium one link rides: text frames in, text frames out,
 * FIFO, reliable while open — deliberately the WebSocket surface (see
 * the module docblock's medium discussion). Implementations MUST
 * deliver frames in send order and MUST NOT deliver after close.
 */
export interface CrossSpaceLinkSocket {
  /** Send one text frame. Throws if the socket is closed. */
  send(frame: string): void;
  /** Observe inbound frames in arrival (= peer send) order. */
  onFrame(handler: (frame: string) => void): () => void;
  /** Observe socket closure (either side; fires at most once). */
  onClose(handler: () => void): () => void;
  close(): void;
}

/**
 * The in-memory serializing duplex: a connected socket pair for two
 * co-hosted transports in one process. Genuine serialization — only
 * strings cross (non-string sends throw), delivered asynchronously
 * (microtask FIFO per direction), so nothing structured survives the
 * boundary and the C3.1 codec is load-bearing end to end.
 *
 * Test seams (the repo's injectable-barrier pattern): `holdDelivery`
 * freezes delivery in BOTH directions until the returned release runs
 * (frames queue; send order preserved) — how fixtures pin "the frame
 * is in flight" states deterministically; `whenQuiet` resolves when
 * both directions have drained (and no hold is active) — the
 * cross-host delivery barrier tests compose with each server's own
 * settle; `framesTransferred` counts delivered frames for
 * quiescence-detection loops.
 */
export interface CrossSpaceLinkSocketPair {
  readonly sockets: readonly [CrossSpaceLinkSocket, CrossSpaceLinkSocket];
  holdDelivery(): () => void;
  whenQuiet(): Promise<void>;
  framesTransferred(): number;
}

export const crossSpaceLinkSocketPair = (): CrossSpaceLinkSocketPair => {
  interface Direction {
    queue: string[];
    drainScheduled: boolean;
    handlers: Set<(frame: string) => void>;
    closeHandlers: Set<() => void>;
  }
  const directions: [Direction, Direction] = [
    {
      queue: [],
      drainScheduled: false,
      handlers: new Set(),
      closeHandlers: new Set(),
    },
    {
      queue: [],
      drainScheduled: false,
      handlers: new Set(),
      closeHandlers: new Set(),
    },
  ];
  let closed = false;
  let holds = 0;
  let transferred = 0;
  const quietWaiters: (() => void)[] = [];

  const quiet = (): boolean =>
    (holds === 0 || closed) &&
    directions[0].queue.length === 0 &&
    directions[1].queue.length === 0;

  const settleQuietWaiters = (): void => {
    if (!quiet()) return;
    while (quietWaiters.length > 0) quietWaiters.shift()!();
  };

  const scheduleDrain = (direction: Direction): void => {
    if (direction.drainScheduled) return;
    direction.drainScheduled = true;
    queueMicrotask(() => {
      direction.drainScheduled = false;
      while (
        !closed && holds === 0 && direction.queue.length > 0
      ) {
        const frame = direction.queue.shift()!;
        transferred += 1;
        for (const handler of [...direction.handlers]) {
          try {
            handler(frame);
          } catch (error) {
            console.warn("cross-space link socket handler failed", error);
          }
        }
      }
      settleQuietWaiters();
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    // Graceful close, like a real socket flushing buffered frames before
    // the FIN/Close frame: frames already sent still deliver (a refusing
    // side's `hello-refused` must reach the peer), THEN close handlers
    // fire — asynchronously, never reentrant into the closer. New sends
    // throw from this point on.
    queueMicrotask(() => {
      for (const direction of directions) {
        while (direction.queue.length > 0) {
          const frame = direction.queue.shift()!;
          transferred += 1;
          for (const handler of [...direction.handlers]) {
            try {
              handler(frame);
            } catch (error) {
              console.warn("cross-space link socket handler failed", error);
            }
          }
        }
      }
      for (const direction of directions) {
        for (const handler of [...direction.closeHandlers]) {
          try {
            handler();
          } catch (error) {
            console.warn("cross-space link socket close handler failed", error);
          }
        }
      }
      settleQuietWaiters();
    });
  };

  // sockets[i] SENDS into directions[i]; the RECEIVER of directions[i]
  // is sockets[1 - i], whose onFrame handlers live on directions[i].
  const socketAt = (index: 0 | 1): CrossSpaceLinkSocket => {
    const outbound = directions[index];
    const inbound = directions[1 - index];
    return {
      send: (frame) => {
        if (closed) {
          throw new CrossSpaceProtocolError(
            "link-closed",
            "cross-space link socket is closed",
          );
        }
        if (typeof frame !== "string") {
          throw new TypeError(
            "cross-space link sockets carry TEXT FRAMES only — the " +
              "co-hosted link is a serialized medium (encode through the " +
              "C3.1 codec first)",
          );
        }
        outbound.queue.push(frame);
        scheduleDrain(outbound);
      },
      onFrame: (handler) => {
        inbound.handlers.add(handler);
        return () => {
          inbound.handlers.delete(handler);
        };
      },
      onClose: (handler) => {
        inbound.closeHandlers.add(handler);
        return () => {
          inbound.closeHandlers.delete(handler);
        };
      },
      close,
    };
  };

  return {
    sockets: [socketAt(0), socketAt(1)],
    holdDelivery: () => {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0) {
          scheduleDrain(directions[0]);
          scheduleDrain(directions[1]);
        }
      };
    },
    whenQuiet: () => {
      if (closed || quiet()) return Promise.resolve();
      return new Promise((resolve) => quietWaiters.push(resolve));
    },
    framesTransferred: () => transferred,
  };
};

/**
 * Adapt an OPEN WebSocket into a link socket — the deployment medium
 * (loopback TCP per the co-hosted assumption set; the caller awaits
 * the socket's `open` event first, following `standalone.ts`'s
 * upgrade pattern). Binary frames are a protocol violation and close
 * the socket (`1003`), mirroring the standalone server's text-only
 * rule; `error` is treated as close.
 */
export const webSocketCrossSpaceLinkSocket = (
  socket: WebSocket,
): CrossSpaceLinkSocket => {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new CrossSpaceProtocolError(
      "link-closed",
      "webSocketCrossSpaceLinkSocket requires an OPEN WebSocket (await " +
        "its open event first)",
    );
  }
  const frameHandlers = new Set<(frame: string) => void>();
  const closeHandlers = new Set<() => void>();
  let closeFired = false;
  const fireClose = (): void => {
    if (closeFired) return;
    closeFired = true;
    for (const handler of [...closeHandlers]) {
      try {
        handler();
      } catch (error) {
        console.warn("cross-space link socket close handler failed", error);
      }
    }
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      socket.close(1003, "cross-space link expects text frames");
      return;
    }
    for (const handler of [...frameHandlers]) {
      try {
        handler(event.data);
      } catch (error) {
        console.warn("cross-space link socket handler failed", error);
      }
    }
  });
  socket.addEventListener("close", fireClose);
  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      // already closing
    }
    fireClose();
  });
  return {
    send: (frame) => {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new CrossSpaceProtocolError(
          "link-closed",
          "cross-space link WebSocket is not open",
        );
      }
      socket.send(frame);
    },
    onFrame: (handler) => {
      frameHandlers.add(handler);
      return () => {
        frameHandlers.delete(handler);
      };
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    close: () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Link-control wire shapes.
// ---------------------------------------------------------------------------

/** Field no C3.1 payload message carries (strict write guarantees it),
 * so it cleanly discriminates control frames. */
const CONTROL_DISCRIMINATOR = "link";

type LinkControlMessage =
  | {
    link: "hello";
    hostId: string;
    protocolVersion: number;
    hostedSpaces: readonly string[];
  }
  | { link: "hello-refused"; reason: string; detail: string }
  | { link: "spaces"; hostedSpaces: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const readDeclaredSpaces = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const spaces = new Set<string>();
  for (const entry of value) {
    if (!isNonEmptyString(entry)) return undefined;
    spaces.add(entry);
  }
  return [...spaces];
};

/** Stable, symmetric link identity from the host-id pair (C3A12: the
 * durable per-link keys must survive reconnects — see the docblock). */
const deriveLinkId = (hostA: string, hostB: string): string =>
  `xsp:link:${JSON.stringify([hostA, hostB].sort())}`;

// ---------------------------------------------------------------------------
// Diagnostics.
// ---------------------------------------------------------------------------

/** Per-link inbound accounting. Every drop is counted where it
 * happens; the C3A13 acceptance counter is `fromSpaceViolationsDropped`. */
export interface CoHostedLinkDiagnostics {
  /** Frames received from the socket (control + payload). */
  framesReceived: number;
  /** Payload frames handed to channel handlers (i.e. the router). */
  framesDelivered: number;
  /** C3A13: payload frames dropped because `fromSpace` was outside the
   * peer's declared set — the link-identity-to-stamp binding firing. */
  fromSpaceViolationsDropped: number;
  /** Payload/control frames dropped as unparseable JSON post-open. */
  malformedFramesDropped: number;
  /** Unknown control messages dropped (additive tolerance). */
  unknownControlDropped: number;
  /** Peer claims dropped for conflicting with local hosting or another
   * live link's route (hello-time conflicts refuse the link instead). */
  conflictingClaimsDropped: number;
  /** Post-open protocol violations observed (e.g. a duplicate hello —
   * closes the link). */
  protocolViolations: number;
}

/** Handle returned by {@link CoHostedCrossSpaceTransport#attachLink}. */
export interface CoHostedCrossSpaceLink {
  /** Resolves when the hello exchange completes and the link is bound;
   * rejects when the link is refused (either side) or closes first. */
  readonly opened: Promise<{ linkId: string; peerHostId: string }>;
  readonly state: "handshaking" | CrossSpaceLinkState;
  /** Bound identity — undefined until `opened`. */
  readonly linkId: string | undefined;
  readonly peerHostId: string | undefined;
  /** The peer's currently-accepted declared set (C3A13 binding). */
  peerHostedSpaces(): readonly string[];
  diagnostics(): CoHostedLinkDiagnostics;
  close(): void;
}

// ---------------------------------------------------------------------------
// The transport.
// ---------------------------------------------------------------------------

export interface CoHostedCrossSpaceTransportOptions {
  /** This host's stable identity in link hellos (and half of every
   * derived linkId). Deployment-stable: reusing it across restarts is
   * what keeps C3A12's linkId-keyed durable state addressable. */
  hostId: string;
  /**
   * Deployment-configured locally-hosted spaces (the `spaceHostMap`
   * shape C3.11's client resolver consumes). Declared in every hello;
   * the `Server` also registers them eagerly at construction so a
   * configured space's protocol inbox exists before its first serve.
   * Dynamic growth (a space first served this lifetime) rides
   * `spaceRegistered` + the `spaces` update instead.
   */
  hostedSpaces?: readonly string[];
}

/**
 * The co-hosted transport: one per host. Local spaces stay on the
 * embedded in-process loopback; spaces a linked peer declared route
 * over that peer's link; unknown spaces fall through to the loopback
 * where the router's unhosted-drop discipline applies. See the module
 * docblock for the full design.
 */
export class CoHostedCrossSpaceTransport implements CrossSpaceTransport {
  readonly kind = "co-hosted-link";
  readonly hostId: string;
  readonly ordering: CrossSpaceOrderingCapability = Object.freeze({
    perLinkFifo: true as const,
    // Honest per the module docblock: one multiplexed in-order link per
    // host pair ⇒ peer emissions arrive in peer send (= commit) order
    // relative to every other frame on the link.
    receiveOrderFencing: true,
    linkTopology: "single-multiplexed-per-host-pair" as const,
  });
  readonly routing: CrossSpaceTransportRouting;

  #loopback = new InProcessCrossSpaceTransport();
  #configured: readonly string[];
  #localSpaces = new Set<string>();
  /** The CURRENT live link impl per peer hostId (one multiplexed link per
   * host pair). Cleared when that impl's socket closes; a reconnect sets a
   * fresh impl. */
  #links = new Map<string, LinkImpl>();
  /**
   * C3.10b: the PERSISTED channel per peer hostId. Outlives individual link
   * incarnations — a socket loss closes the current impl but keeps the
   * channel so a reconnect rebinds the SAME object (its router/server
   * onMessage/onLifecycle subscriptions survive), bumping `incarnation` and
   * firing `reconnected`. Dropped only when the transport closes.
   */
  #channels = new Map<string, LinkChannel>();
  /** Attached links still in (or failed) handshake, so close() reaps them. */
  #attachedLinks = new Set<LinkImpl>();
  /** space → the open link whose peer declared it. */
  #routes = new Map<string, LinkImpl>();
  #channelSubscribers = new Set<(channel: CrossSpaceChannel) => void>();
  #closed = false;

  constructor(options: CoHostedCrossSpaceTransportOptions) {
    if (!isNonEmptyString(options.hostId)) {
      throw new CrossSpaceProtocolError(
        "malformed-message",
        "co-hosted transport requires a non-empty hostId",
      );
    }
    this.hostId = options.hostId;
    this.#configured = [...new Set(options.hostedSpaces ?? [])];
    for (const space of this.#configured) {
      this.#localSpaces.add(space);
    }
    this.routing = {
      peerHostFor: (space) => this.#routes.get(space)?.peerHostId,
      routedSpaces: () => [...this.#routes.keys()],
      configuredLocalSpaces: () => this.#configured,
      onChannel: (handler) => {
        this.#channelSubscribers.add(handler);
        // Replay already-open links so router/link construction order
        // is free (see CrossSpaceTransportRouting).
        for (const link of this.#links.values()) {
          const channel = link.openChannel();
          if (channel !== undefined) handler(channel);
        }
        return () => {
          this.#channelSubscribers.delete(handler);
        };
      },
      spaceRegistered: (space) => this.#spaceRegistered(space),
    };
  }

  /** Attach one duplex to a peer host and begin the hello exchange. */
  attachLink(socket: CrossSpaceLinkSocket): CoHostedCrossSpaceLink {
    if (this.#closed) {
      throw new CrossSpaceProtocolError(
        "router-closed",
        "co-hosted cross-space transport is closed",
      );
    }
    const link = new LinkImpl(this, socket);
    this.#attachedLinks.add(link);
    return link;
  }

  channelTo(space: string): CrossSpaceChannel {
    // Local wins by construction (routes never adopt for a local space);
    // checking local first keeps that authority explicit.
    if (this.#localSpaces.has(space)) {
      return this.#loopback.channelTo(space);
    }
    const routed = this.#routes.get(space);
    if (routed !== undefined) {
      const channel = routed.openChannel();
      if (channel !== undefined) return channel;
    }
    // Unknown (or the route's link just closed): the loopback, where
    // the router's unhosted-toSpace drop keeps the send side-effect
    // free — the C3.1b discipline for never-hosted names.
    return this.#loopback.channelTo(space);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const link of [...this.#attachedLinks]) {
      link.close();
    }
    // Permanently retire persisted channels (a transport close is not a
    // reconnectable socket loss): fire `closed` for any still-open channel.
    for (const channel of this.#channels.values()) {
      channel.retire();
    }
    this.#attachedLinks.clear();
    this.#links.clear();
    this.#channels.clear();
    this.#routes.clear();
    this.#channelSubscribers.clear();
    this.#loopback.close();
  }

  // ------------------------------------------------------------------
  // Internal wiring (LinkImpl calls back into the transport).
  // ------------------------------------------------------------------

  #spaceRegistered(space: string): void {
    if (this.#closed) return;
    if (this.#localSpaces.has(space)) return;
    this.#localSpaces.add(space);
    // Belt: a live route for a now-locally-registered space is a
    // hosting conflict. Local serve wins locally (this host IS serving
    // it); the stale route retires with a counter. The Server's
    // openEngine routing gate makes this unreachable on the serve path;
    // bare-router uses can still hit it.
    const conflicted = this.#routes.get(space);
    if (conflicted !== undefined) {
      conflicted.diagnostics_.conflictingClaimsDropped += 1;
      conflicted.dropPeerSpace(space);
      this.#routes.delete(space);
      console.warn(
        `cross-space link ${conflicted.linkId}: retiring peer route for ` +
          `${space} — the space registered locally (hosting conflict)`,
      );
    }
    for (const link of this.#links.values()) {
      link.syncLocalDeclaration();
    }
  }

  localSpacesSnapshot(): readonly string[] {
    return [...this.#localSpaces];
  }

  hasLocalSpace(space: string): boolean {
    return this.#localSpaces.has(space);
  }

  peerLink(peerHostId: string): LinkImpl | undefined {
    return this.#links.get(peerHostId);
  }

  /**
   * A link completed its hello: bind it as the current impl for its peer,
   * adopt its routes, and resolve the channel. Returns the channel plus
   * whether this was a RECONNECT (a persisted channel for a now-closed
   * prior incarnation was rebound and its `incarnation` bumped) or a FRESH
   * open (a new channel to announce). Returns undefined when a LIVE channel
   * already holds the peer slot — the caller refuses `duplicate-link`.
   * (C3.10b: this is where reconnect keeps the channel identity stable.)
   */
  bindLink(
    link: LinkImpl,
    peerHostId: string,
    linkId: string,
    accepted: ReadonlySet<string>,
  ): { channel: LinkChannel; reconnected: boolean } | undefined {
    if (this.#closed) return undefined;
    const existing = this.#channels.get(peerHostId);
    if (existing !== undefined && existing.isLive()) {
      return undefined;
    }
    this.#links.set(peerHostId, link);
    this.reconcileRoutes(link, accepted);
    if (existing === undefined) {
      const channel = new LinkChannel(link, linkId);
      this.#channels.set(peerHostId, channel);
      return { channel, reconnected: false };
    }
    // Reconnect: the persisted channel was closed with the prior incarnation;
    // rebind it to this impl and bump its incarnation (dead-incarnation state
    // is dropped by incarnation compare — C3A12).
    existing.rebind(link);
    return { channel: existing, reconnected: true };
  }

  announceChannel(channel: CrossSpaceChannel): void {
    for (const subscriber of [...this.#channelSubscribers]) {
      try {
        subscriber(channel);
      } catch (error) {
        console.warn("cross-space onChannel subscriber failed", error);
      }
    }
  }

  /** Adopt/retire routes for `link` so its routed set equals
   * `accepted`. Conflict claims were already filtered by the caller. */
  reconcileRoutes(link: LinkImpl, accepted: ReadonlySet<string>): void {
    for (const [space, routed] of [...this.#routes]) {
      if (routed === link && !accepted.has(space)) {
        this.#routes.delete(space);
      }
    }
    for (const space of accepted) {
      this.#routes.set(space, link);
    }
  }

  /** Is `space` currently routed to a DIFFERENT live link? */
  routedElsewhere(space: string, link: LinkImpl): boolean {
    const routed = this.#routes.get(space);
    return routed !== undefined && routed !== link;
  }

  linkClosed(link: LinkImpl): void {
    this.#attachedLinks.delete(link);
    if (link.peerHostId !== undefined) {
      if (this.#links.get(link.peerHostId) === link) {
        this.#links.delete(link.peerHostId);
        // C3.10b: the current impl for this peer just closed. Transition the
        // PERSISTED channel to closed (firing `closed` for the home host's
        // dead-link revocation) but keep it in `#channels` so a reconnect
        // rebinds this exact object. A stale impl (already superseded by a
        // reconnect) never reaches here as the current impl, so it cannot
        // knock a live channel down.
        this.#channels.get(link.peerHostId)?.onImplClosed(link);
      }
    }
    for (const [space, routed] of [...this.#routes]) {
      if (routed === link) this.#routes.delete(space);
    }
  }
}

// ---------------------------------------------------------------------------
// One link.
// ---------------------------------------------------------------------------

class LinkImpl implements CoHostedCrossSpaceLink {
  readonly opened: Promise<{ linkId: string; peerHostId: string }>;
  diagnostics_: CoHostedLinkDiagnostics = {
    framesReceived: 0,
    framesDelivered: 0,
    fromSpaceViolationsDropped: 0,
    malformedFramesDropped: 0,
    unknownControlDropped: 0,
    conflictingClaimsDropped: 0,
    protocolViolations: 0,
  };

  #transport: CoHostedCrossSpaceTransport;
  #socket: CrossSpaceLinkSocket;
  #state: "handshaking" | CrossSpaceLinkState = "handshaking";
  #linkId: string | undefined;
  #peerHostId: string | undefined;
  #peerSpaces = new Set<string>();
  #channel: LinkChannel | undefined;
  /** Local set as last declared to the peer (hello or `spaces`). */
  #declaredLocalKey: string;
  #resolveOpened!: (bound: { linkId: string; peerHostId: string }) => void;
  #rejectOpened!: (error: Error) => void;
  #detachFrame: () => void;
  #detachClose: () => void;

  constructor(
    transport: CoHostedCrossSpaceTransport,
    socket: CrossSpaceLinkSocket,
  ) {
    this.#transport = transport;
    this.#socket = socket;
    this.opened = new Promise((resolve, reject) => {
      this.#resolveOpened = resolve;
      this.#rejectOpened = reject;
    });
    // The refusal path rejects `opened` before anyone could have
    // awaited it; that must not become an unhandled rejection.
    this.opened.catch(() => {});
    this.#detachFrame = socket.onFrame((frame) => this.#onFrame(frame));
    this.#detachClose = socket.onClose(() => this.#onSocketClosed());
    const local = transport.localSpacesSnapshot();
    this.#declaredLocalKey = JSON.stringify([...local].sort());
    socket.send(JSON.stringify({
      link: "hello",
      hostId: transport.hostId,
      protocolVersion: CROSS_SPACE_PROTOCOL_VERSION,
      hostedSpaces: [...local].sort(),
    }));
  }

  get state(): "handshaking" | CrossSpaceLinkState {
    return this.#state;
  }

  get linkId(): string | undefined {
    return this.#linkId;
  }

  get peerHostId(): string | undefined {
    return this.#peerHostId;
  }

  peerHostedSpaces(): readonly string[] {
    return [...this.#peerSpaces].sort();
  }

  diagnostics(): CoHostedLinkDiagnostics {
    return { ...this.diagnostics_ };
  }

  openChannel(): CrossSpaceChannel | undefined {
    return this.#channel;
  }

  sendWire(wire: string): void {
    if (this.#state !== "open") {
      throw new CrossSpaceProtocolError(
        "link-closed",
        `cross-space link ${this.#linkId ?? "(unbound)"} is not open`,
      );
    }
    this.#socket.send(wire);
  }

  dropPeerSpace(space: string): void {
    this.#peerSpaces.delete(space);
  }

  /** Redeclare the local hosted set when it changed (FIFO-ordered
   * before any frame from a newly registered space — see docblock). */
  syncLocalDeclaration(): void {
    if (this.#state !== "open") return;
    const local = [...this.#transport.localSpacesSnapshot()].sort();
    const key = JSON.stringify(local);
    if (key === this.#declaredLocalKey) return;
    this.#declaredLocalKey = key;
    try {
      this.#socket.send(JSON.stringify({
        link: "spaces",
        hostedSpaces: local,
      }));
    } catch (error) {
      console.warn("cross-space link spaces update failed", error);
    }
  }

  close(): void {
    this.#teardown("link closed locally");
  }

  // ------------------------------------------------------------------

  #onFrame(frame: string): void {
    if (this.#state === "closed") return;
    this.diagnostics_.framesReceived += 1;
    let raw: unknown;
    try {
      raw = JSON.parse(frame);
    } catch {
      raw = undefined;
    }
    if (!isRecord(raw)) {
      if (this.#state === "handshaking") {
        this.#refuse(
          "malformed-frame",
          "the first frame on a link must be a JSON hello",
        );
      } else {
        this.diagnostics_.malformedFramesDropped += 1;
        console.warn(
          `cross-space link ${this.#linkId} dropped an unparseable frame`,
        );
      }
      return;
    }
    if (typeof raw[CONTROL_DISCRIMINATOR] === "string") {
      this.#onControl(raw as Record<string, unknown> & { link: string });
      return;
    }
    this.#onPayload(raw, frame);
  }

  #onControl(control: Record<string, unknown> & { link: string }): void {
    switch (control.link) {
      case "hello":
        this.#onHello(control);
        return;
      case "hello-refused": {
        const detail = isNonEmptyString(control.detail)
          ? control.detail
          : "(no detail)";
        const reason = isNonEmptyString(control.reason)
          ? control.reason
          : "unspecified";
        this.#teardown(`peer refused the link (${reason}): ${detail}`);
        return;
      }
      case "spaces":
        this.#onSpacesUpdate(control);
        return;
      default:
        // Additive tolerance, mirroring the codec's unknown-type
        // posture: count and drop, keep the link.
        this.diagnostics_.unknownControlDropped += 1;
        console.warn(
          `cross-space link ${this.#linkId ?? "(unbound)"} dropped ` +
            `unknown control message "${control.link}"`,
        );
    }
  }

  #onHello(control: Record<string, unknown>): void {
    if (this.#state !== "handshaking") {
      // One hello per link per incarnation; a second is a protocol
      // violation and closes the link loudly (reconnect — a NEW hello
      // on a NEW incarnation — is C3.10b's, dated 2026-07-18).
      this.diagnostics_.protocolViolations += 1;
      this.#teardown("duplicate hello on an open link");
      return;
    }
    const declared = readDeclaredSpaces(control.hostedSpaces);
    if (
      !isNonEmptyString(control.hostId) ||
      typeof control.protocolVersion !== "number" ||
      declared === undefined
    ) {
      this.#refuse(
        "malformed-hello",
        "hello must carry hostId, protocolVersion, and hostedSpaces[]",
      );
      return;
    }
    if (control.protocolVersion !== CROSS_SPACE_PROTOCOL_VERSION) {
      this.#refuse(
        "version-mismatch",
        `peer speaks cross-space protocol v${control.protocolVersion}; ` +
          `this host speaks v${CROSS_SPACE_PROTOCOL_VERSION} (cross-` +
          "version coexistence is a link-negotiation concern — refused)",
      );
      return;
    }
    if (control.hostId === this.#transport.hostId) {
      this.#refuse(
        "self-link",
        `peer claims this host's own id (${control.hostId}) — a host ` +
          "never links itself",
      );
      return;
    }
    if (this.#transport.peerLink(control.hostId) !== undefined) {
      this.#refuse(
        "duplicate-link",
        `host ${control.hostId} is already linked — one multiplexed ` +
          "link per host pair (reconnect is C3.10b's)",
      );
      return;
    }
    const conflicts = declared.filter((space) =>
      this.#transport.hasLocalSpace(space)
    );
    if (conflicts.length > 0) {
      this.#refuse(
        "space-conflict",
        `peer ${control.hostId} declares spaces this host hosts ` +
          `(${conflicts.join(", ")}) — split-brain hosting is a ` +
          "deployment error",
      );
      return;
    }
    // Bind: identity, declared set, routes, channel.
    this.#peerHostId = control.hostId;
    this.#linkId = deriveLinkId(this.#transport.hostId, control.hostId);
    const accepted = new Set<string>();
    for (const space of declared) {
      if (this.#transport.routedElsewhere(space, this)) {
        this.diagnostics_.conflictingClaimsDropped += 1;
        console.warn(
          `cross-space link ${this.#linkId}: dropping claim for ${space} ` +
            "— another live link already routes it",
        );
        continue;
      }
      accepted.add(space);
    }
    this.#peerSpaces = accepted;
    const binding = this.#transport.bindLink(
      this,
      control.hostId,
      this.#linkId,
      accepted,
    );
    if (binding === undefined) {
      this.#refuse(
        "duplicate-link",
        `host ${control.hostId} is already linked`,
      );
      return;
    }
    this.#state = "open";
    this.#channel = binding.channel;
    if (binding.reconnected) {
      // C3.10b reconnect: `bindLink` rebound the persisted channel to THIS
      // impl and bumped its incarnation. Fire `reconnected` on the same
      // object — the router's onMessage and the server's onLifecycle
      // subscriptions are intact, so no re-announce; the home host's
      // resync/re-register drills off this event.
      this.#channel.fireLifecycle({
        kind: "reconnected",
        incarnation: this.#channel.incarnation,
      });
    } else {
      this.#transport.announceChannel(this.#channel);
      this.#channel.fireLifecycle({
        kind: "open",
        incarnation: this.#channel.incarnation,
      });
    }
    // The local set may have grown between our hello and the peer's;
    // FIFO ensures this lands before any frame relying on it.
    this.syncLocalDeclaration();
    this.#resolveOpened({
      linkId: this.#linkId,
      peerHostId: control.hostId,
    });
  }

  #onSpacesUpdate(control: Record<string, unknown>): void {
    if (this.#state !== "open") {
      this.#refuse(
        "protocol-violation",
        "spaces update before hello",
      );
      return;
    }
    const declared = readDeclaredSpaces(control.hostedSpaces);
    if (declared === undefined) {
      this.diagnostics_.malformedFramesDropped += 1;
      console.warn(
        `cross-space link ${this.#linkId} dropped a malformed spaces update`,
      );
      return;
    }
    const accepted = new Set<string>();
    for (const space of declared) {
      if (this.#transport.hasLocalSpace(space)) {
        // Post-open drift is contained, not fatal (bring-up conflicts
        // refuse at hello): the claim drops, counted, and stays out of
        // the accepted set — the peer cannot stamp for our spaces.
        this.diagnostics_.conflictingClaimsDropped += 1;
        console.warn(
          `cross-space link ${this.#linkId}: dropping claim for ${space} ` +
            "— hosted locally (hosting conflict)",
        );
        continue;
      }
      if (this.#transport.routedElsewhere(space, this)) {
        this.diagnostics_.conflictingClaimsDropped += 1;
        console.warn(
          `cross-space link ${this.#linkId}: dropping claim for ${space} ` +
            "— another live link already routes it",
        );
        continue;
      }
      accepted.add(space);
    }
    this.#peerSpaces = accepted;
    this.#transport.reconcileRoutes(this, accepted);
  }

  #onPayload(raw: Record<string, unknown>, frame: string): void {
    if (this.#state !== "open") {
      this.diagnostics_.protocolViolations += 1;
      this.#refuse(
        "protocol-violation",
        "payload frame before hello completed",
      );
      return;
    }
    // THE C3A13 gate: the link is bound to the peer's identity for its
    // declared spaces — a frame stamping any other fromSpace drops
    // HERE, before any handler (zero side effects), with the counter.
    const fromSpace = raw.fromSpace;
    if (!isNonEmptyString(fromSpace) || !this.#peerSpaces.has(fromSpace)) {
      this.diagnostics_.fromSpaceViolationsDropped += 1;
      console.warn(
        `cross-space link ${this.#linkId} dropped a frame stamped ` +
          `fromSpace=${String(fromSpace)} — outside the peer's declared ` +
          `set (C3A13: a host may only stamp spaces routed to it)`,
      );
      return;
    }
    this.diagnostics_.framesDelivered += 1;
    this.#channel?.deliver(frame);
  }

  #refuse(reason: string, detail: string): void {
    try {
      this.#socket.send(JSON.stringify({
        link: "hello-refused",
        reason,
        detail,
      }));
    } catch {
      // The peer is gone; the teardown below still runs.
    }
    this.#teardown(`link refused (${reason}): ${detail}`);
  }

  #onSocketClosed(): void {
    this.#teardown("socket closed");
  }

  #teardown(cause: string): void {
    if (this.#state === "closed") return;
    const wasOpen = this.#state === "open";
    this.#state = "closed";
    this.#detachFrame();
    this.#detachClose();
    // C3.10b: `linkClosed` transitions the persisted channel to closed (via
    // `onImplClosed`) — that is the single place `closed` fires, so a reconnect
    // firing `reconnected` and a loss firing `closed` never race a double
    // event, and a stale/superseded impl (already replaced by a reconnect)
    // cannot knock the live channel down.
    this.#transport.linkClosed(this);
    try {
      this.#socket.close();
    } catch {
      // already closed
    }
    if (!wasOpen) {
      this.#rejectOpened(
        new CrossSpaceProtocolError(
          "link-closed",
          `cross-space link closed before opening: ${cause}`,
        ),
      );
    }
  }
}

/**
 * The {@link CrossSpaceChannel} face of one link identity. Created when
 * the link first opens (routes cannot resolve to it earlier, so the
 * router always observes a bound linkId) and PERSISTED across reconnects
 * (C3.10b): a socket loss closes the current {@link LinkImpl} but this
 * object survives so the router's `onMessage` and the server's
 * `onLifecycle` subscriptions stay bound. `incarnation` starts at 1 and
 * bumps on each reconnect; consumers drop dead-incarnation state by
 * comparing it (C3A12).
 */
class LinkChannel implements CrossSpaceChannel {
  readonly linkId: string;
  #incarnation = 1;
  /** The CURRENT impl frames send through / arrive on. Swapped on reconnect. */
  #link: LinkImpl;
  /** The current impl is closed (outage window, awaiting reconnect). */
  #closed = false;
  /** The transport closed — permanent, never reconnects. */
  #retired = false;
  #messageHandlers = new Set<(wire: string) => void>();
  #lifecycleHandlers = new Set<
    (event: CrossSpaceLinkLifecycleEvent) => void
  >();

  constructor(link: LinkImpl, linkId: string) {
    this.#link = link;
    this.linkId = linkId;
  }

  get incarnation(): number {
    return this.#incarnation;
  }

  get state(): CrossSpaceLinkState {
    return this.#closed ? "closed" : "open";
  }

  send(wire: string): void {
    this.#link.sendWire(wire);
  }

  deliver(wire: string): void {
    for (const handler of [...this.#messageHandlers]) {
      try {
        handler(wire);
      } catch (error) {
        console.warn("cross-space channel handler failed", error);
      }
    }
  }

  fireLifecycle(event: CrossSpaceLinkLifecycleEvent): void {
    for (const handler of [...this.#lifecycleHandlers]) {
      try {
        handler(event);
      } catch (error) {
        console.warn("cross-space lifecycle handler failed", error);
      }
    }
  }

  /** True while a live impl backs this channel — the duplicate-link gate. */
  isLive(): boolean {
    return !this.#closed && !this.#retired;
  }

  /** C3.10b: the peer's current impl closed (socket loss). Fire `closed`
   * exactly once and enter the outage window; the object persists so a
   * later reconnect rebinds it. A stale impl (already superseded) is
   * ignored so it cannot knock a live channel down. */
  onImplClosed(link: LinkImpl): void {
    if (link !== this.#link || this.#closed) return;
    this.#closed = true;
    this.fireLifecycle({ kind: "closed" });
  }

  /** C3.10b: a reconnected impl took the peer slot — swap to it, bump the
   * incarnation, and reopen. `reconnected` is fired by the caller (LinkImpl)
   * after this, on the same handler set. */
  rebind(link: LinkImpl): void {
    this.#link = link;
    this.#incarnation += 1;
    this.#closed = false;
  }

  /** Transport close: permanent retirement (fire `closed` if still open). */
  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    if (!this.#closed) {
      this.#closed = true;
      this.fireLifecycle({ kind: "closed" });
    }
  }

  onMessage(handler: (wire: string) => void): () => void {
    this.#messageHandlers.add(handler);
    return () => {
      this.#messageHandlers.delete(handler);
    };
  }

  onLifecycle(
    handler: (event: CrossSpaceLinkLifecycleEvent) => void,
  ): () => void {
    this.#lifecycleHandlers.add(handler);
    return () => {
      this.#lifecycleHandlers.delete(handler);
    };
  }

  close(): void {
    this.#link.close();
  }
}

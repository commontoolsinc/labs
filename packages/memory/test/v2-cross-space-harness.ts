// C3.1 transport-parameterized conformance harness — the reusable
// exchange fixture every later C3 WO runs against its own transport
// (C3.10a swaps in the co-hosted link factory; C3.10b re-runs the
// wake/point-read/fence fixtures through the same seams).
//
// The harness drives the canonical subscribe → notice → point-read
// exchange between two spaces and asserts the MODULE-BOUNDARY rule: every
// protocol step is observed at the receiving side's registered inbox —
// i.e. the exchange happens via transport messages only. A direct-call
// bypass (application logic invoked without the message crossing the
// transport — the C3A1 in-process-accident shape) fails the transcript
// assertions. That discrimination is itself pinned by a committed
// negative fixture via the `pointReadDelivery: "direct-call"` seam
// (the FB4/FB5 lesson: a fixture must bind the bypass it names).
//
// Barrier-driven throughout — every await is a promise resolved by a
// delivery, never a sleep.
import { assert, assertEquals } from "@std/assert";
import {
  CROSS_SPACE_PROTOCOL_VERSION,
  type CrossSpaceDeliveryContext,
  CrossSpaceHostRouter,
  type CrossSpaceInboundHandler,
  type CrossSpaceLinkEndpoint,
  type CrossSpaceMessage,
  type CrossSpaceOrderingCapability,
  demandedPieceIdsOfSubscribe,
  type ForeignPointRead,
  type ForeignPointReadResult,
  type ForeignReadersSubscribe,
  type ForeignStaleReaders,
  InProcessCrossSpaceTransport,
} from "../v2/cross-space.ts";
import { userExecutionContextKey } from "../v2.ts";

export const HARNESS_HOME_SPACE = "did:key:z6Mk-xsp-harness-home";
export const HARNESS_READ_SPACE = "did:key:z6Mk-xsp-harness-read";
const SPONSOR = "did:key:z6Mk-xsp-harness-sponsor";
const LANE_PRINCIPAL = "did:key:z6Mk-xsp-harness-alice";

/**
 * What a transport supplies to the harness: two registered-inbox seams
 * (the ONLY delivery path — the taps count these) and two directed send
 * endpoints. The in-process fixture wraps one `CrossSpaceHostRouter`;
 * C3.10a's fixture wraps two linked Servers.
 */
export interface CrossSpaceExchangeFixture {
  readonly ordering: CrossSpaceOrderingCapability;
  readonly homeSpace: string;
  readonly readSpace: string;
  registerHome(handler: CrossSpaceInboundHandler): () => void;
  registerRead(handler: CrossSpaceInboundHandler): () => void;
  /** Directed endpoint homeSpace → readSpace (register home first). */
  homeEndpoint(): CrossSpaceLinkEndpoint;
  /** Directed endpoint readSpace → homeSpace (register read first). */
  readEndpoint(): CrossSpaceLinkEndpoint;
  close(): Promise<void> | void;
}

export type CrossSpaceExchangeFixtureFactory = () =>
  | Promise<CrossSpaceExchangeFixture>
  | CrossSpaceExchangeFixture;

/**
 * In-process fixture over a host router (a bare one by default; pass a
 * Server-owned router to prove the server seam wires the same object).
 * `closeRouter: false` leaves closing to the router's owner.
 */
export const inProcessExchangeFixture = (
  options: {
    router?: CrossSpaceHostRouter;
    closeRouter?: boolean;
    homeSpace?: string;
    readSpace?: string;
  } = {},
): CrossSpaceExchangeFixture => {
  const router = options.router ??
    new CrossSpaceHostRouter(new InProcessCrossSpaceTransport());
  const closeRouter = options.closeRouter ?? (options.router === undefined);
  const homeSpace = options.homeSpace ?? HARNESS_HOME_SPACE;
  const readSpace = options.readSpace ?? HARNESS_READ_SPACE;
  return {
    ordering: router.ordering,
    homeSpace,
    readSpace,
    registerHome: (handler) => {
      const registration = router.register(homeSpace, handler);
      return () => registration.close();
    },
    registerRead: (handler) => {
      const registration = router.register(readSpace, handler);
      return () => registration.close();
    },
    homeEndpoint: () => router.link(homeSpace, readSpace),
    readEndpoint: () => router.link(readSpace, homeSpace),
    close: () => {
      if (closeRouter) router.close();
    },
  };
};

export interface CrossSpaceExchangeOptions {
  /**
   * TEST SEAM (boundary discrimination): how the home host issues the
   * point read. "transport" (default) sends over the home endpoint;
   * "direct-call" invokes the read side's application logic directly
   * WITHOUT the message crossing the transport — the C3A1 bypass shape.
   * The conformance assertions must then fail; the committed negative
   * fixture pins that they do.
   */
  pointReadDelivery?: "transport" | "direct-call";
}

export interface CrossSpaceExchangeTranscript {
  /** Every message delivered to the read space's inbox, in order. */
  atRead: readonly CrossSpaceMessage[];
  /** Every message delivered to the home space's inbox, in order. */
  atHome: readonly CrossSpaceMessage[];
  subscribe: ForeignReadersSubscribe;
  notice: ForeignStaleReaders;
  request: ForeignPointRead;
  result: ForeignPointReadResult;
}

interface Inbox {
  readonly messages: CrossSpaceMessage[];
  readonly contexts: CrossSpaceDeliveryContext[];
  push(message: CrossSpaceMessage, context: CrossSpaceDeliveryContext): void;
  waitFor(
    predicate: (message: CrossSpaceMessage) => boolean,
  ): Promise<CrossSpaceMessage>;
}

const makeInbox = (): Inbox => {
  const messages: CrossSpaceMessage[] = [];
  const contexts: CrossSpaceDeliveryContext[] = [];
  const waiters: {
    predicate: (message: CrossSpaceMessage) => boolean;
    resolve: (message: CrossSpaceMessage) => void;
  }[] = [];
  return {
    messages,
    contexts,
    push: (message, context) => {
      messages.push(message);
      contexts.push(context);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].predicate(message)) {
          const [waiter] = waiters.splice(i, 1);
          waiter.resolve(message);
        }
      }
    },
    waitFor: (predicate) => {
      const existing = messages.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
};

/**
 * Run the canonical two-space exchange over the fixture's transport and
 * assert conformance. Returns the transcript so later WOs can layer
 * their own assertions on the same run.
 */
export const runCrossSpaceExchangeConformance = async (
  factory: CrossSpaceExchangeFixtureFactory,
  options: CrossSpaceExchangeOptions = {},
): Promise<CrossSpaceExchangeTranscript> => {
  const pointReadDelivery = options.pointReadDelivery ?? "transport";
  const fixture = await factory();
  try {
    assert(
      fixture.ordering.perLinkFifo,
      "transport must declare the per-link FIFO floor",
    );
    const readInbox = makeInbox();
    const homeInbox = makeInbox();

    // The inboxes are pure recorders: the registered handler IS the
    // transport receive seam the conformance assertions count. The
    // read side's application responses are scripted by the driver
    // below, gated on inbox receipt — so a step whose message never
    // crossed the transport is visible as a missing inbox entry.
    const unregisterRead = fixture.registerRead((message, context) => {
      readInbox.push(message, context);
    });
    const unregisterHome = fixture.registerHome((message, context) => {
      homeInbox.push(message, context);
    });
    const homeEndpoint = fixture.homeEndpoint();
    const readEndpoint = fixture.readEndpoint();

    const noticeReaders = [
      {
        branch: "",
        pieceId: "piece:home:alpha",
        processGeneration: 0,
        actionId: "action:alpha:1",
        executionContextKey: "space" as const,
      },
    ];
    const servedDocument = { value: { greeting: "hi from read space" } };
    // Read-side application logic for the point read, callable with a
    // transport-delivered request (the honest path) or a locally
    // composed one (the bypass demo). It responds ONLY via the read
    // endpoint — the bypass under test is the request leg.
    const respondToPointRead = (message: ForeignPointRead): void => {
      readEndpoint.send({
        type: "foreign-point-read.result",
        requestId: message.requestId,
        result: {
          status: "served",
          seq: 7,
          branch: "",
          document: servedDocument,
          authorizationEpoch: {
            space: fixture.readSpace,
            principal: message.actingPrincipal.principal,
            epoch: 0,
          },
        },
      });
    };

    try {
      // Step 1 — subscribe, twice back-to-back (generations 1 then 2):
      // the second registration doubles as the behavioral per-link FIFO
      // probe. Lane demands mirror the A4 shape: the space lane (whose
      // pieces ARE the demanded piece ids) plus an open user lane.
      const laneDemands = [
        {
          contextKey: "space" as const,
          pieces: ["piece:home:alpha", "piece:home:beta"],
        },
        {
          contextKey: userExecutionContextKey(LANE_PRINCIPAL),
          pieces: ["piece:home:alpha"],
        },
      ];
      homeEndpoint.send({
        type: "foreign-readers.subscribe",
        branch: "",
        laneDemands,
        subscriptionGeneration: 1,
      });
      homeEndpoint.send({
        type: "foreign-readers.subscribe",
        branch: "",
        laneDemands,
        subscriptionGeneration: 2,
      });
      const subscribe = await readInbox.waitFor(
        (message) =>
          message.type === "foreign-readers.subscribe" &&
          message.subscriptionGeneration === 2,
      ) as ForeignReadersSubscribe;

      // Step 2 — the read space's commit matched the subscribed demand
      // (scripted, gated on the subscribe having ARRIVED); the notice
      // reaches the home inbox over the transport.
      readEndpoint.send({
        type: "foreign-stale-readers",
        branch: "",
        commitSeq: 7,
        readers: noticeReaders,
      });
      const notice = await homeInbox.waitFor(
        (message) => message.type === "foreign-stale-readers",
      ) as ForeignStaleReaders;

      // Step 3 — the home host issues the point read (or bypasses the
      // transport under the discrimination seam).
      const requestInit = {
        type: "foreign-point-read" as const,
        requestId: "xsp-pr-1",
        address: {
          id: "doc:read:1",
          scope: "space" as const,
          path: ["value"],
        },
        actingPrincipal: {
          principal: SPONSOR,
          contextKey: "space" as const,
          claim: {
            pieceId: "piece:home:alpha",
            actionId: "action:alpha:1",
            leaseGeneration: 3,
            claimGeneration: 5,
          },
        },
      };
      if (pointReadDelivery === "transport") {
        homeEndpoint.send(requestInit);
        const delivered = await readInbox.waitFor(
          (message) => message.type === "foreign-point-read",
        ) as ForeignPointRead;
        respondToPointRead(delivered);
      } else {
        // C3A1 bypass shape: the read side's application logic runs on
        // a locally composed request that never crossed the transport.
        // The conformance assertions below MUST red on this.
        respondToPointRead(
          {
            ...requestInit,
            v: CROSS_SPACE_PROTOCOL_VERSION,
            linkId: homeEndpoint.linkId,
            fromSpace: fixture.homeSpace,
            toSpace: fixture.readSpace,
          } satisfies ForeignPointRead,
        );
      }
      const result = await homeInbox.waitFor(
        (message) => message.type === "foreign-point-read.result",
      ) as ForeignPointReadResult;

      // --- Conformance assertions ---

      // THE seam-integrity rule: every protocol step was observed at the
      // receiving side's registered inbox — the exchange happened via
      // transport messages only. This is the assertion a direct-call
      // bypass reds.
      assertEquals(
        readInbox.messages.map((message) => message.type),
        [
          "foreign-readers.subscribe",
          "foreign-readers.subscribe",
          "foreign-point-read",
        ],
        "read inbox must observe subscribe (twice, FIFO) then the point " +
          "read via the transport",
      );
      assertEquals(
        homeInbox.messages.map((message) => message.type),
        ["foreign-stale-readers", "foreign-point-read.result"],
        "home inbox must observe the notice then the point-read result " +
          "via the transport",
      );

      // Per-link FIFO, behaviorally: generation 1 delivered before 2.
      assertEquals(
        readInbox.messages
          .filter((m): m is ForeignReadersSubscribe =>
            m.type === "foreign-readers.subscribe"
          )
          .map((m) => m.subscriptionGeneration),
        [1, 2],
        "per-link FIFO: subscribes must arrive in send order",
      );

      // Envelope integrity on every delivered message.
      const deliveries = [
        { inbox: readInbox, space: fixture.readSpace, peer: fixture.homeSpace },
        { inbox: homeInbox, space: fixture.homeSpace, peer: fixture.readSpace },
      ];
      const linkIds = new Set<string>();
      for (const { inbox, space, peer } of deliveries) {
        for (const [index, message] of inbox.messages.entries()) {
          const context = inbox.contexts[index];
          assertEquals(message.v, CROSS_SPACE_PROTOCOL_VERSION);
          assertEquals(message.toSpace, space);
          assertEquals(message.fromSpace, peer);
          assertEquals(context.space, space);
          assertEquals(context.fromSpace, peer);
          assertEquals(
            message.linkId,
            context.linkId,
            "a message carries the identity of the link it arrived on",
          );
          linkIds.add(message.linkId);
        }
      }
      if (
        fixture.ordering.linkTopology === "single-multiplexed-per-host-pair"
      ) {
        assertEquals(
          linkIds.size,
          1,
          "a single-multiplexed transport carries the whole exchange on " +
            "one link",
        );
      }

      // Payload round-trip fidelity.
      assertEquals([...demandedPieceIdsOfSubscribe(subscribe)], [
        "piece:home:alpha",
        "piece:home:beta",
      ]);
      assertEquals(
        subscribe.laneDemands.map((lane) => lane.contextKey),
        laneDemands.map((lane) => lane.contextKey),
      );
      assertEquals(notice.commitSeq, 7);
      assertEquals([...notice.readers], noticeReaders);
      const laneKeys = new Set(
        subscribe.laneDemands.map((lane) => lane.contextKey),
      );
      for (const reader of notice.readers) {
        assert(
          laneKeys.has(reader.executionContextKey),
          "a matched reader identity names a subscribed lane",
        );
        assert(
          demandedPieceIdsOfSubscribe(subscribe).includes(reader.pieceId),
          "a matched reader identity names a demanded piece",
        );
      }
      const request = readInbox.messages.find(
        (message): message is ForeignPointRead =>
          message.type === "foreign-point-read",
      );
      assert(request !== undefined, "point read crossed the transport");
      assertEquals(result.requestId, request.requestId);
      assert(result.result.status === "served");
      assertEquals(result.result.seq, 7);
      assertEquals(result.result.document, servedDocument);
      assertEquals(result.result.authorizationEpoch, {
        space: fixture.readSpace,
        principal: SPONSOR,
        epoch: 0,
      });

      return {
        atRead: [...readInbox.messages],
        atHome: [...homeInbox.messages],
        subscribe,
        notice,
        request,
        result,
      };
    } finally {
      unregisterRead();
      unregisterHome();
    }
  } finally {
    await fixture.close();
  }
};

// C3.1 — cross-engine protocol substrate at the HOST boundary (standing
// decision #1: Server↔Server, engines passive). Codec round-trip + malformed
// rejection conformance for every message in the C3.1 vocabulary, the
// in-process transport's ordering/lifecycle contract, the host router's
// registration + link-integrity seams, the transport-parameterized exchange
// harness (subscribe → notice → point-read over the transport object), the
// committed C3A1 bypass discrimination, and the module-boundary rule that
// the protocol module imports no engine/server internals.
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
  type CrossSpaceLinkLifecycleEvent,
  type CrossSpaceMessage,
  CrossSpaceProtocolError,
  demandedPieceIdsOfSubscribe,
  encodeCrossSpaceMessage,
  InProcessCrossSpaceTransport,
  parseCrossSpaceMessage,
} from "../v2/cross-space.ts";
import { Server } from "../v2/server.ts";
import { sessionExecutionContextKey, userExecutionContextKey } from "../v2.ts";
import {
  inProcessExchangeFixture,
  runCrossSpaceExchangeConformance,
} from "./v2-cross-space-harness.ts";

const HOME = "did:key:z6Mk-xsp-home";
const READ = "did:key:z6Mk-xsp-read";
const ALICE = "did:key:z6Mk-xsp-alice";
const LINK = "xsp:test:link-1";

const envelope = {
  v: CROSS_SPACE_PROTOCOL_VERSION,
  linkId: LINK,
  fromSpace: HOME,
  toSpace: READ,
};
// Read-host → home-host direction (notices, results, bumps).
const reverseEnvelope = {
  v: CROSS_SPACE_PROTOCOL_VERSION,
  linkId: LINK,
  fromSpace: READ,
  toSpace: HOME,
};

const ENVELOPE_KEYS = ["v", "linkId", "fromSpace", "toSpace", "type"];

const validSubscribe: CrossSpaceMessage = {
  ...envelope,
  type: "foreign-readers.subscribe",
  branch: "",
  laneDemands: [
    {
      contextKey: "space",
      pieces: ["piece:home:alpha", "piece:home:beta"],
    },
    {
      contextKey: userExecutionContextKey(ALICE),
      pieces: ["piece:home:alpha"],
    },
    {
      contextKey: sessionExecutionContextKey(ALICE, "session-1"),
      pieces: ["piece:home:beta"],
    },
  ],
  subscriptionGeneration: 1,
};

// A JSON-clean accepted-observation payload for the mirror (the codec
// validates it shallowly; deep validation is the applying host's, via the
// engine's own validator — module boundary).
const mirrorObservation = {
  version: 1,
  ownerSpace: HOME,
  branch: "",
  pieceId: "of:piece",
  processGeneration: 1,
  actionId: "pattern.tsx:computed:1",
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:test",
  observedAtSeq: 0,
  inputBasisSeq: 0,
  transactionKind: "action-run",
  reads: [{
    space: READ,
    scope: "space",
    id: "of:source",
    path: ["value", "count"],
  }],
  shallowReads: [],
  actualChangedWrites: [],
  currentKnownWrites: [],
  declaredWrites: [],
  materializerWriteEnvelopes: [],
  status: "success",
};

const validMirror: CrossSpaceMessage = {
  ...envelope,
  type: "foreign-observation.mirror",
  branch: "",
  observedAtSeq: 7,
  originExecutionContextKey: sessionExecutionContextKey(ALICE, "session-1"),
  scopeContext: { principal: ALICE, sessionId: "session-1" },
  writerSessionId: sessionExecutionContextKey(ALICE, "session-1"),
  observation: mirrorObservation,
};

const validPointRead: CrossSpaceMessage = {
  ...envelope,
  type: "foreign-point-read",
  requestId: "xsp-pr-1",
  address: { id: "doc:read:1", scope: "space", path: ["value"] },
  actingPrincipal: {
    principal: ALICE,
    contextKey: "space",
    claim: {
      pieceId: "piece:home:alpha",
      actionId: "action:alpha:1",
      leaseGeneration: 3,
      claimGeneration: 5,
    },
  },
};

const validServedResult: CrossSpaceMessage = {
  ...reverseEnvelope,
  type: "foreign-point-read.result",
  requestId: "xsp-pr-1",
  result: {
    status: "served",
    seq: 7,
    branch: "",
    document: { value: { greeting: "hi" } },
    authorizationEpoch: { space: READ, principal: ALICE, epoch: 2 },
  },
};

const VALID_MESSAGES: {
  name: string;
  message: CrossSpaceMessage;
  payloadKeys: string[];
}[] = [
  {
    name: "foreign-readers.subscribe (A4 lane pairs, post-C2.7 shape)",
    message: validSubscribe,
    payloadKeys: ["branch", "laneDemands", "subscriptionGeneration"],
  },
  {
    name: "foreign-readers.unsubscribe",
    message: {
      ...envelope,
      type: "foreign-readers.unsubscribe",
      branch: "",
      subscriptionGeneration: 2,
    },
    payloadKeys: ["branch", "subscriptionGeneration"],
  },
  {
    name: "foreign-stale-readers (matched identities)",
    message: {
      ...reverseEnvelope,
      type: "foreign-stale-readers",
      branch: "",
      commitSeq: 7,
      readers: [
        {
          branch: "",
          pieceId: "piece:home:alpha",
          processGeneration: 0,
          actionId: "action:alpha:1",
          executionContextKey: "space",
        },
        {
          branch: "",
          pieceId: "piece:home:beta",
          processGeneration: 1,
          actionId: "action:beta:1",
          executionContextKey: sessionExecutionContextKey(ALICE, "session-1"),
        },
      ],
    },
    payloadKeys: ["branch", "commitSeq", "readers"],
  },
  {
    name: "foreign-stale-readers (empty match — a well-formed no-op)",
    message: {
      ...reverseEnvelope,
      type: "foreign-stale-readers",
      branch: "feature",
      commitSeq: 9,
      readers: [],
    },
    payloadKeys: ["branch", "commitSeq", "readers"],
  },
  {
    name: "foreign-observation.mirror (C3.1b — the wire form of the " +
      "mirrored-observation upsert; retraction rides the same message)",
    message: validMirror,
    payloadKeys: [
      "branch",
      "observedAtSeq",
      "originExecutionContextKey",
      "scopeContext",
      "writerSessionId",
      "observation",
    ],
  },
  {
    name: "foreign-observation.mirror (seq 0 — an operations-empty home " +
      "commit)",
    message: { ...validMirror, observedAtSeq: 0 },
    payloadKeys: [
      "branch",
      "observedAtSeq",
      "originExecutionContextKey",
      "scopeContext",
      "writerSessionId",
      "observation",
    ],
  },
  {
    name: "foreign-dirty-mark (C3.1b durable-dirt carriage, option (b))",
    message: {
      ...reverseEnvelope,
      type: "foreign-dirty-mark",
      branch: "",
      dirtySeq: 4,
      readers: [
        {
          branch: "",
          pieceId: "of:piece",
          processGeneration: 1,
          actionId: "pattern.tsx:computed:1",
          executionContextKey: sessionExecutionContextKey(ALICE, "session-1"),
        },
      ],
    },
    payloadKeys: ["branch", "dirtySeq", "readers"],
  },
  {
    name: "foreign-dirty-mark (empty readers — a well-formed no-op)",
    message: {
      ...reverseEnvelope,
      type: "foreign-dirty-mark",
      branch: "",
      dirtySeq: 9,
      readers: [],
    },
    payloadKeys: ["branch", "dirtySeq", "readers"],
  },
  {
    name: "foreign-point-read (claim reference, never credentials)",
    message: validPointRead,
    payloadKeys: ["requestId", "address", "actingPrincipal"],
  },
  {
    name: "foreign-point-read.result (served: seq + snapshot + epoch stamp)",
    message: validServedResult,
    payloadKeys: ["requestId", "result"],
  },
  {
    name: "foreign-point-read.result (denied)",
    message: {
      ...reverseEnvelope,
      type: "foreign-point-read.result",
      requestId: "xsp-pr-2",
      result: { status: "denied", code: "foreign-read-access-denied" },
    },
    payloadKeys: ["requestId", "result"],
  },
  {
    name: "foreign-authorization-epoch.bump (principal)",
    message: {
      ...reverseEnvelope,
      type: "foreign-authorization-epoch.bump",
      target: { kind: "principal", principal: ALICE },
      epoch: 4,
    },
    payloadKeys: ["target", "epoch"],
  },
  {
    name: "foreign-authorization-epoch.bump (space-wide floor, C3A3)",
    message: {
      ...reverseEnvelope,
      type: "foreign-authorization-epoch.bump",
      target: { kind: "floor" },
      epoch: 1,
    },
    payloadKeys: ["target", "epoch"],
  },
  {
    name: "foreign-authorization-epoch.query (narrowed)",
    message: {
      ...envelope,
      type: "foreign-authorization-epoch.query",
      requestId: "xsp-eq-1",
      principals: [ALICE],
    },
    payloadKeys: ["requestId", "principals"],
  },
  {
    name: "foreign-authorization-epoch.query (everything)",
    message: {
      ...envelope,
      type: "foreign-authorization-epoch.query",
      requestId: "xsp-eq-2",
    },
    payloadKeys: ["requestId"],
  },
  {
    name: "foreign-authorization-epoch.query.result",
    message: {
      ...reverseEnvelope,
      type: "foreign-authorization-epoch.query.result",
      requestId: "xsp-eq-1",
      epochFloor: 1,
      epochs: [{ principal: ALICE, epoch: 4 }],
    },
    payloadKeys: ["requestId", "epochFloor", "epochs"],
  },
];

Deno.test("cross-space codec: round-trip conformance for every message", async (t) => {
  for (const { name, message, payloadKeys } of VALID_MESSAGES) {
    await t.step(name, () => {
      const wire = encodeCrossSpaceMessage(message);
      // Strict write: exactly the envelope + known payload fields.
      assertEquals(
        Object.keys(JSON.parse(wire)).sort(),
        [...ENVELOPE_KEYS, ...payloadKeys].sort(),
      );
      const parsed = parseCrossSpaceMessage(wire);
      assert(parsed.ok, `expected ok, got ${JSON.stringify(parsed)}`);
      assertEquals(parsed.message, message);
      // Parsed messages are frozen — handlers can never mutate a frame.
      assert(Object.isFrozen(parsed.message));
    });
  }
});

const MALFORMED: {
  name: string;
  raw: Record<string, unknown>;
  detailIncludes: string;
}[] = [
  {
    name: "subscribe: empty laneDemands",
    raw: { ...validSubscribe, laneDemands: [] },
    detailIncludes: "non-empty",
  },
  {
    name: "subscribe: first lane pair is not the space lane",
    raw: {
      ...validSubscribe,
      laneDemands: [
        { contextKey: userExecutionContextKey(ALICE), pieces: ["p"] },
      ],
    },
    detailIncludes: "laneDemands[0] must be the space-lane pair",
  },
  {
    name: "subscribe: a second space-lane pair",
    raw: {
      ...validSubscribe,
      laneDemands: [
        { contextKey: "space", pieces: ["p"] },
        { contextKey: "space", pieces: ["q"] },
      ],
    },
    detailIncludes: "exactly one space-lane pair",
  },
  {
    name: "subscribe: duplicate lane context key",
    raw: {
      ...validSubscribe,
      laneDemands: [
        { contextKey: "space", pieces: ["p"] },
        { contextKey: userExecutionContextKey(ALICE), pieces: ["p"] },
        { contextKey: userExecutionContextKey(ALICE), pieces: ["q"] },
      ],
    },
    detailIncludes: "repeats context key",
  },
  {
    name: "subscribe: non-canonical context key (raw colon-bearing DID)",
    raw: {
      ...validSubscribe,
      laneDemands: [
        { contextKey: "space", pieces: ["p"] },
        { contextKey: `user:${ALICE}`, pieces: ["p"] },
      ],
    },
    detailIncludes: "canonical",
  },
  {
    name: "subscribe: zero subscription generation",
    raw: { ...validSubscribe, subscriptionGeneration: 0 },
    detailIncludes: "positive",
  },
  {
    name: "unsubscribe: missing branch",
    raw: {
      ...envelope,
      type: "foreign-readers.unsubscribe",
      subscriptionGeneration: 1,
    },
    detailIncludes: "branch",
  },
  {
    name: "stale-readers: zero commit seq",
    raw: {
      ...reverseEnvelope,
      type: "foreign-stale-readers",
      branch: "",
      commitSeq: 0,
      readers: [],
    },
    detailIncludes: "commitSeq",
  },
  {
    name: "stale-readers: reader identity missing actionId",
    raw: {
      ...reverseEnvelope,
      type: "foreign-stale-readers",
      branch: "",
      commitSeq: 1,
      readers: [
        {
          branch: "",
          pieceId: "p",
          processGeneration: 0,
          executionContextKey: "space",
        },
      ],
    },
    detailIncludes: "actionId",
  },
  {
    name: "mirror: negative observedAtSeq",
    raw: { ...validMirror, observedAtSeq: -1 },
    detailIncludes: "observedAtSeq",
  },
  {
    name: "mirror: non-canonical origin execution context key",
    raw: { ...validMirror, originExecutionContextKey: `user:${ALICE}` },
    detailIncludes: "originExecutionContextKey",
  },
  {
    name: "mirror: scope context without a session id",
    raw: { ...validMirror, scopeContext: { principal: ALICE } },
    detailIncludes: "scopeContext.sessionId",
  },
  {
    name: "mirror: missing writer session key",
    raw: { ...validMirror, writerSessionId: "" },
    detailIncludes: "writerSessionId",
  },
  {
    name: "mirror: observation smuggles an execution context key " +
      "(carve-out — context rides originExecutionContextKey)",
    raw: {
      ...validMirror,
      observation: { ...mirrorObservation, executionContextKey: "space" },
    },
    detailIncludes: 'must not carry "executionContextKey"',
  },
  {
    name: "mirror: observation carries a claim assertion (transient " +
      "protocol-boundary field the accepted form has stripped)",
    raw: {
      ...validMirror,
      observation: {
        ...mirrorObservation,
        executionClaimAssertion: {
          contextKey: "space",
          leaseGeneration: 1,
          claimGeneration: 1,
        },
      },
    },
    detailIncludes: 'must not carry "executionClaimAssertion"',
  },
  {
    name: "mirror: observation.ownerSpace differs from the envelope's " +
      "fromSpace (a host mirrors only observations of the space it " +
      "speaks for — C3A13)",
    raw: {
      ...validMirror,
      observation: { ...mirrorObservation, ownerSpace: READ },
    },
    detailIncludes: "must equal the envelope's fromSpace",
  },
  {
    name: "mirror: observation without a piece id",
    raw: {
      ...validMirror,
      observation: { ...mirrorObservation, pieceId: "" },
    },
    detailIncludes: "observation.pieceId",
  },
  {
    name: "dirty-mark: zero dirty seq (only operations-empty commits " +
      "carry seq 0, and those dirty nothing)",
    raw: {
      ...reverseEnvelope,
      type: "foreign-dirty-mark",
      branch: "",
      dirtySeq: 0,
      readers: [],
    },
    detailIncludes: "dirtySeq",
  },
  {
    name: "dirty-mark: reader identity missing actionId",
    raw: {
      ...reverseEnvelope,
      type: "foreign-dirty-mark",
      branch: "",
      dirtySeq: 1,
      readers: [
        {
          branch: "",
          pieceId: "p",
          processGeneration: 0,
          executionContextKey: "space",
        },
      ],
    },
    detailIncludes: "actionId",
  },
  {
    name: "point-read: address smuggles a space (carve-out, not tolerated)",
    raw: {
      ...validPointRead,
      address: { id: "doc:read:1", path: ["value"], space: HOME },
    },
    detailIncludes: 'must not carry "space"',
  },
  {
    name: "point-read: address smuggles a scopeKey (carve-out)",
    raw: {
      ...validPointRead,
      address: { id: "doc:read:1", path: ["value"], scopeKey: "user:x" },
    },
    detailIncludes: 'must not carry "scopeKey"',
  },
  {
    name: "point-read: undeclared scope value",
    raw: {
      ...validPointRead,
      address: { id: "doc:read:1", scope: "global", path: [] },
    },
    detailIncludes: "declared cell scope",
  },
  {
    name: "point-read: acting principal without a principal",
    raw: {
      ...validPointRead,
      actingPrincipal: { contextKey: "space" },
    },
    detailIncludes: "principal",
  },
  {
    name: "point-read: claim with zero lease generation",
    raw: {
      ...validPointRead,
      actingPrincipal: {
        principal: ALICE,
        contextKey: "space",
        claim: {
          pieceId: "p",
          actionId: "a",
          leaseGeneration: 0,
          claimGeneration: 1,
        },
      },
    },
    detailIncludes: "positive lease/claim generations",
  },
  {
    name: "result: unknown status arm",
    raw: {
      ...reverseEnvelope,
      type: "foreign-point-read.result",
      requestId: "r",
      result: { status: "maybe" },
    },
    detailIncludes: "result.status",
  },
  {
    name: "result: served with zero seq",
    raw: {
      ...reverseEnvelope,
      type: "foreign-point-read.result",
      requestId: "r",
      result: {
        status: "served",
        seq: 0,
        branch: "",
        document: null,
        authorizationEpoch: { space: READ, principal: ALICE, epoch: 0 },
      },
    },
    detailIncludes: "result.seq",
  },
  {
    name: "result: non-document snapshot",
    raw: {
      ...reverseEnvelope,
      type: "foreign-point-read.result",
      requestId: "r",
      result: {
        status: "served",
        seq: 1,
        branch: "",
        document: "not-a-document",
        authorizationEpoch: { space: READ, principal: ALICE, epoch: 0 },
      },
    },
    detailIncludes: "document",
  },
  {
    name: "result: epoch stamp for a space the sender does not speak for " +
      "(C3A13 structural half)",
    raw: {
      ...reverseEnvelope,
      type: "foreign-point-read.result",
      requestId: "r",
      result: {
        status: "served",
        seq: 1,
        branch: "",
        document: null,
        authorizationEpoch: { space: HOME, principal: ALICE, epoch: 0 },
      },
    },
    detailIncludes: "stamps only spaces it speaks for",
  },
  {
    name: "result: denied without a code",
    raw: {
      ...reverseEnvelope,
      type: "foreign-point-read.result",
      requestId: "r",
      result: { status: "denied" },
    },
    detailIncludes: "result.code",
  },
  {
    name: "bump: unknown target kind",
    raw: {
      ...reverseEnvelope,
      type: "foreign-authorization-epoch.bump",
      target: { kind: "wildcard" },
      epoch: 1,
    },
    detailIncludes: "target.kind",
  },
  {
    name: "bump: negative epoch",
    raw: {
      ...reverseEnvelope,
      type: "foreign-authorization-epoch.bump",
      target: { kind: "floor" },
      epoch: -1,
    },
    detailIncludes: "epoch",
  },
  {
    name: "query: empty principal in the narrowing list",
    raw: {
      ...envelope,
      type: "foreign-authorization-epoch.query",
      requestId: "r",
      principals: [""],
    },
    detailIncludes: "principals",
  },
  {
    name: "query.result: entry without an epoch",
    raw: {
      ...reverseEnvelope,
      type: "foreign-authorization-epoch.query.result",
      requestId: "r",
      epochFloor: 0,
      epochs: [{ principal: ALICE }],
    },
    detailIncludes: "epochs[0]",
  },
];

Deno.test("cross-space codec: malformed rejection per message", async (t) => {
  for (const { name, raw, detailIncludes } of MALFORMED) {
    await t.step(name, () => {
      const parsed = parseCrossSpaceMessage(JSON.stringify(raw));
      assert(!parsed.ok, `expected rejection for ${name}`);
      assertEquals(parsed.error, "malformed-message");
      assert(
        parsed.detail.includes(detailIncludes),
        `detail "${parsed.detail}" should mention "${detailIncludes}"`,
      );
      // The encoder refuses the same value at the SEND site.
      assertThrows(
        () => encodeCrossSpaceMessage(raw as unknown as CrossSpaceMessage),
        CrossSpaceProtocolError,
      );
    });
  }
});

Deno.test("cross-space codec: envelope discipline", async (t) => {
  await t.step("non-JSON frame", () => {
    const parsed = parseCrossSpaceMessage("not json");
    assert(!parsed.ok);
    assertEquals(parsed.error, "malformed-json");
  });
  await t.step("non-record frame", () => {
    const parsed = parseCrossSpaceMessage("42");
    assert(!parsed.ok);
    assertEquals(parsed.error, "malformed-envelope");
  });
  await t.step("missing / non-integer version", () => {
    for (const v of [undefined, 0, -1, 1.5, "1"]) {
      const parsed = parseCrossSpaceMessage(
        JSON.stringify({ ...validSubscribe, v }),
      );
      assert(!parsed.ok);
      assertEquals(parsed.error, "malformed-envelope");
    }
  });
  await t.step(
    "non-current version is unsupported-version, not malformed " +
      "(the breaking-change fence; coexistence is link negotiation)",
    () => {
      const parsed = parseCrossSpaceMessage(
        JSON.stringify({ ...validSubscribe, v: 2 }),
      );
      assert(!parsed.ok);
      assertEquals(parsed.error, "unsupported-version");
      assertEquals(parsed.v, 2);
      assertEquals(parsed.type, "foreign-readers.subscribe");
    },
  );
  await t.step("missing link identity", () => {
    const parsed = parseCrossSpaceMessage(
      JSON.stringify({ ...validSubscribe, linkId: undefined }),
    );
    assert(!parsed.ok);
    assertEquals(parsed.error, "malformed-envelope");
    assert(parsed.detail.includes("linkId"));
  });
  await t.step("a space never speaks the protocol to itself", () => {
    const parsed = parseCrossSpaceMessage(
      JSON.stringify({ ...validSubscribe, toSpace: HOME }),
    );
    assert(!parsed.ok);
    assertEquals(parsed.error, "malformed-envelope");
    assert(parsed.detail.includes("differ"));
  });
  await t.step(
    "unknown type is distinguishable (additive evolution: C3.1b's " +
      "messages slotted in without a version bump)",
    () => {
      // The dirt-snapshot leg is C3.1b's documented option-(a) slot — a
      // plausible future additive message, unknown today.
      const parsed = parseCrossSpaceMessage(
        JSON.stringify({
          ...envelope,
          type: "foreign-dirt-snapshot",
          rows: [],
        }),
      );
      assert(!parsed.ok);
      assertEquals(parsed.error, "unknown-type");
      assertEquals(parsed.type, "foreign-dirt-snapshot");
      assertEquals(parsed.v, CROSS_SPACE_PROTOCOL_VERSION);
      // And the type C3.1 used as its unknown-type example IS now known
      // (C3.1b landed it additively, still protocol v1): a malformed
      // body of it is malformed-message, no longer unknown-type.
      const known = parseCrossSpaceMessage(
        JSON.stringify({
          ...envelope,
          type: "foreign-observation.mirror",
          upsert: {},
        }),
      );
      assert(!known.ok);
      assertEquals(known.error, "malformed-message");
      assertEquals(known.v, CROSS_SPACE_PROTOCOL_VERSION);
    },
  );
});

Deno.test("cross-space codec: additive-tolerant read, strict write", async (t) => {
  await t.step("unknown fields are ignored on read, dropped on write", () => {
    const wire = JSON.parse(encodeCrossSpaceMessage(validSubscribe));
    wire.dirtSnapshot = [{ ownerSpace: HOME, directDirtySeq: 3 }];
    wire.laneDemands[0].futureHint = true;
    const parsed = parseCrossSpaceMessage(JSON.stringify(wire));
    assert(parsed.ok);
    // The parsed value carries EXACTLY the known fields...
    assertEquals(parsed.message, validSubscribe);
    // ...so a re-encode is byte-identical to the clean encoding: the
    // tolerated unknowns never survive a round trip.
    assertEquals(
      encodeCrossSpaceMessage(parsed.message),
      encodeCrossSpaceMessage(validSubscribe),
    );
  });
  await t.step("the encoder strips unknown fields it is handed", () => {
    const dirty = {
      ...validSubscribe,
      sneakyExtra: "field",
    } as unknown as CrossSpaceMessage;
    assertEquals(
      encodeCrossSpaceMessage(dirty),
      encodeCrossSpaceMessage(validSubscribe),
    );
  });
  await t.step(
    "the encoder throws at the send site on a malformed value",
    () => {
      assertThrows(
        () =>
          encodeCrossSpaceMessage({
            ...validSubscribe,
            subscriptionGeneration: 0,
          } as CrossSpaceMessage),
        CrossSpaceProtocolError,
        "refusing to encode",
      );
    },
  );
});

const microtaskBarrier = (): Promise<void> =>
  new Promise((resolve) => queueMicrotask(resolve));

Deno.test("in-process transport: multiplexed per-link FIFO, encode-through, lifecycle", async (t) => {
  await t.step(
    "declares the C3A7 slot: FIFO floor + receive-order fencing on a " +
      "single multiplexed host-pair link",
    () => {
      const transport = new InProcessCrossSpaceTransport();
      assertEquals(transport.ordering, {
        perLinkFifo: true,
        receiveOrderFencing: true,
        linkTopology: "single-multiplexed-per-host-pair",
      });
      transport.close();
    },
  );

  await t.step(
    "delivery order is global send order across BOTH directions (the " +
      "receive-order guarantee the declaration claims)",
    async () => {
      const router = new CrossSpaceHostRouter(
        new InProcessCrossSpaceTransport(),
      );
      const timeline: string[] = [];
      router.register(HOME, (message) => {
        timeline.push(`home<-${message.type}`);
      });
      router.register(READ, (message) => {
        timeline.push(`read<-${message.type}`);
      });
      const homeToRead = router.link(HOME, READ);
      const readToHome = router.link(READ, HOME);
      assertEquals(
        homeToRead.linkId,
        readToHome.linkId,
        "one multiplexed link per host pair",
      );
      homeToRead.send({
        type: "foreign-readers.subscribe",
        branch: "",
        laneDemands: [{ contextKey: "space", pieces: ["p"] }],
        subscriptionGeneration: 1,
      });
      readToHome.send({
        type: "foreign-stale-readers",
        branch: "",
        commitSeq: 1,
        readers: [],
      });
      homeToRead.send({
        type: "foreign-readers.unsubscribe",
        branch: "",
        subscriptionGeneration: 1,
      });
      await microtaskBarrier();
      assertEquals(timeline, [
        "read<-foreign-readers.subscribe",
        "home<-foreign-stale-readers",
        "read<-foreign-readers.unsubscribe",
      ]);
      router.close();
    },
  );

  await t.step(
    "encode-through: a malformed body fails loudly at the send site and " +
      "nothing is delivered",
    async () => {
      const router = new CrossSpaceHostRouter(
        new InProcessCrossSpaceTransport(),
      );
      let delivered = 0;
      router.register(HOME, () => {});
      router.register(READ, () => {
        delivered += 1;
      });
      const endpoint = router.link(HOME, READ);
      assertThrows(
        () =>
          endpoint.send({
            type: "foreign-readers.subscribe",
            branch: "",
            laneDemands: [],
            subscriptionGeneration: 1,
          }),
        CrossSpaceProtocolError,
        "refusing to encode",
      );
      await microtaskBarrier();
      assertEquals(delivered, 0);
      router.close();
    },
  );

  await t.step(
    "close: lifecycle event, endpoint state, send refusal",
    async () => {
      const router = new CrossSpaceHostRouter(
        new InProcessCrossSpaceTransport(),
      );
      router.register(HOME, () => {});
      router.register(READ, () => {});
      const endpoint = router.link(HOME, READ);
      assertEquals(endpoint.state, "open");
      assertEquals(endpoint.incarnation, 1);
      const events: CrossSpaceLinkLifecycleEvent[] = [];
      endpoint.onLifecycle((event) => events.push(event));
      router.close();
      assertEquals(events, [{ kind: "closed" }]);
      assertEquals(endpoint.state, "closed");
      assertThrows(
        () =>
          endpoint.send({
            type: "foreign-readers.unsubscribe",
            branch: "",
            subscriptionGeneration: 1,
          }),
        CrossSpaceProtocolError,
        "closed",
      );
      await microtaskBarrier();
    },
  );
});

Deno.test("cross-space router: hosted-space registry and link integrity", async (t) => {
  await t.step(
    "registration is the hosted-space knowledge (C3.1b's gate)",
    () => {
      const router = new CrossSpaceHostRouter(
        new InProcessCrossSpaceTransport(),
      );
      assertEquals(router.hostedSpaces(), []);
      assertEquals(router.isHosted(HOME), false);
      const registration = router.register(HOME, () => {});
      assert(router.isHosted(HOME));
      assertEquals(router.hostedSpaces(), [HOME]);
      // Hosting is exclusive per space.
      assertThrows(
        () => router.register(HOME, () => {}),
        CrossSpaceProtocolError,
        "already registered",
      );
      registration.close();
      assertEquals(router.isHosted(HOME), false);
      router.close();
    },
  );

  await t.step("a host only speaks for spaces it hosts (C3A13 seed)", () => {
    const router = new CrossSpaceHostRouter(
      new InProcessCrossSpaceTransport(),
    );
    router.register(HOME, () => {});
    assertThrows(
      () => router.link(READ, HOME),
      CrossSpaceProtocolError,
      "not registered",
    );
    assertThrows(
      () => router.link(HOME, HOME),
      CrossSpaceProtocolError,
      "never speaks the cross-space protocol to itself",
    );
    router.close();
  });

  await t.step(
    "delivery to an unhosted space is dropped with no side effects " +
      "(the router never conjures state for a space it does not host)",
    async () => {
      const router = new CrossSpaceHostRouter(
        new InProcessCrossSpaceTransport(),
      );
      let homeDeliveries = 0;
      router.register(HOME, () => {
        homeDeliveries += 1;
      });
      const endpoint = router.link(HOME, READ);
      endpoint.send({
        type: "foreign-readers.unsubscribe",
        branch: "",
        subscriptionGeneration: 1,
      });
      await microtaskBarrier();
      assertEquals(router.isHosted(READ), false);
      assertEquals(homeDeliveries, 0);
      router.close();
    },
  );

  await t.step(
    "a frame stamped for a different link is dropped (link-identity " +
      "integrity; the routing-table binding is C3.10a's)",
    async () => {
      const transport = new InProcessCrossSpaceTransport();
      const router = new CrossSpaceHostRouter(transport);
      let delivered = 0;
      router.register(HOME, () => {});
      router.register(READ, () => {
        delivered += 1;
      });
      // Ensure the router is subscribed to the channel.
      router.link(HOME, READ);
      const channel = transport.channelTo(READ);
      channel.send(encodeCrossSpaceMessage({
        ...envelope,
        linkId: "xsp:spoofed-link",
        type: "foreign-readers.unsubscribe",
        branch: "",
        subscriptionGeneration: 1,
      }));
      // A non-protocol frame is dropped the same way, without throwing.
      channel.send("garbage");
      await microtaskBarrier();
      assertEquals(delivered, 0);
      router.close();
    },
  );
});

Deno.test("C3.1 exchange conformance: subscribe → notice → point-read over the in-process transport", async () => {
  const transcript = await runCrossSpaceExchangeConformance(() =>
    inProcessExchangeFixture()
  );
  assertEquals(transcript.result.result.status, "served");
  assertEquals(
    [...demandedPieceIdsOfSubscribe(transcript.subscribe)],
    ["piece:home:alpha", "piece:home:beta"],
  );
});

Deno.test("C3.1 server seam: the Server-owned router runs the same exchange and stays inert plumbing", async () => {
  const server = new Server({
    authorizeSessionOpen: () => undefined,
    sessionOpenAuth: { audience: "did:key:z6Mk-xsp-audience" },
  });
  const router = server.crossSpaceRouter();
  assert(router instanceof CrossSpaceHostRouter);
  assertEquals(
    server.crossSpaceRouter(),
    router,
    "one router per host",
  );
  // Inert: constructing a Server registers nothing — hosted-space
  // knowledge is C3.1b's to wire (and only then may openEngine gate on
  // it).
  assertEquals(router.hostedSpaces(), []);
  const transcript = await runCrossSpaceExchangeConformance(() =>
    inProcessExchangeFixture({ router, closeRouter: false })
  );
  assertEquals(transcript.atRead.length, 3);
  await server.close();
  // Server.close closes the seam.
  assertThrows(
    () => router.register(HOME, () => {}),
    CrossSpaceProtocolError,
    "closed",
  );
});

Deno.test("C3A1 discrimination: an exchange leg bypassing the transport fails the harness", async () => {
  await assertRejects(
    () =>
      runCrossSpaceExchangeConformance(
        () => inProcessExchangeFixture(),
        { pointReadDelivery: "direct-call" },
      ),
    AssertionError,
    "via the transport",
  );
});

Deno.test("module boundary: the protocol module imports no engine/server internals", async () => {
  const source = await Deno.readTextFile(
    new URL("../v2/cross-space.ts", import.meta.url),
  );
  const specifiers = [
    ...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gms),
  ].map((match) => match[1]);
  assert(specifiers.length > 0, "expected import statements");
  assertEquals(
    [...new Set(specifiers)],
    ["../v2.ts"],
    "cross-space.ts may import ONLY the shared wire-type module " +
      "(../v2.ts) — never engine.ts/server.ts internals. If this fails " +
      "you are moving the protocol boundary: stop and re-read the C3.1 " +
      "module docblock",
  );
  assert(
    !/\bimport\s*\(/.test(source),
    "no dynamic imports around the boundary either",
  );
});

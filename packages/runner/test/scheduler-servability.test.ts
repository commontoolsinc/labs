import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type ClientCommit,
  type ExecutionClaim,
  sessionExecutionContextKey,
  toDocumentPath,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import {
  SCOPE_NAMING_LINK_CONFORMANCE,
  scopeNamingLinkForPath,
  SESSION_SCOPE_NAMING_LINK_CONFORMANCE,
} from "@commonfabric/memory/v2/scope-naming-link";
import {
  classifyStaticActionServability,
  type StaticActionServabilityCandidate,
} from "../src/scheduler.ts";
import {
  actionClaimChainMapKey,
  dynamicActionTransactionUnservableReason,
  executionClaimMatchesActionChain,
  ownChainContextKeys,
} from "../src/scheduler/servability.ts";
import type {
  CompleteActionScopeSummary,
  SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { ActionTransactionRouteInput } from "../src/storage/v2.ts";

const servedSpace = "did:key:served" as const;
const foreignSpace = "did:key:foreign" as const;

function address(
  id: string,
  overrides: Partial<IMemorySpaceAddress> = {},
): IMemorySpaceAddress {
  return {
    space: servedSpace,
    scope: "space",
    id: id as IMemorySpaceAddress["id"],
    path: ["value"],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<StaticActionServabilityCandidate> = {},
): StaticActionServabilityCandidate {
  const output = address("of:output");
  return {
    actionKind: "computation",
    ownerSpace: servedSpace,
    pieceId: "space:of:piece",
    implementationFingerprint: "impl:computation-v1",
    runtimeFingerprint: "runner:scheduler:v3",
    completeActionScopeSummary: {
      version: 1,
      complete: true,
      implementationFingerprint: "impl:computation-v1",
      runtimeFingerprint: "runner:scheduler:v3",
      piece: address("of:piece"),
      reads: [address("of:input")],
      writes: [output],
      materializerWriteEnvelopes: [],
      directOutputs: [output],
    },
    ...overrides,
  };
}

function withSummary(
  overrides: Record<string, unknown>,
): StaticActionServabilityCandidate {
  const base = candidate();
  return {
    ...base,
    completeActionScopeSummary: {
      ...base.completeActionScopeSummary as Record<string, unknown>,
      ...overrides,
    },
  };
}

describe("static action servability", () => {
  it("marks a complete same-space computation claim-ready", () => {
    expect(classifyStaticActionServability(candidate(), servedSpace)).toEqual({
      status: "claim-ready",
      actionKind: "computation",
    });
  });

  it("separates complete effects that require the W1.4 broker", () => {
    expect(classifyStaticActionServability(
      candidate({ actionKind: "effect" }),
      servedSpace,
    )).toEqual({
      status: "broker-required",
      actionKind: "effect",
    });
  });

  it("fails closed for incomplete and unknown effect surfaces", () => {
    expect(classifyStaticActionServability(
      candidate({ completeActionScopeSummary: undefined }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "incomplete-static-surface",
    });
    expect(classifyStaticActionServability(
      candidate({
        actionKind: "effect",
        completeActionScopeSummary: undefined,
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "unknown-effect-surface",
    });
  });

  it("rejects malformed and untrusted summaries", () => {
    expect(classifyStaticActionServability(null, servedSpace)).toEqual({
      status: "unservable",
      reason: "malformed-candidate",
    });
    expect(classifyStaticActionServability(
      withSummary({ complete: false }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "malformed-static-surface",
    });
    expect(classifyStaticActionServability(
      candidate({
        implementationFingerprint: "action:fallback",
        completeActionScopeSummary: {
          ...candidate().completeActionScopeSummary as Record<string, unknown>,
          implementationFingerprint: "action:fallback",
        },
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "untrusted-implementation",
    });
  });

  it("treats a canonical builtin (cf:builtin/<id>:v1) fingerprint as trusted", () => {
    // W2.11: a raw builtin now carries `impl:cf:builtin/<id>:v1`. It must clear
    // the fingerprint gate exactly like any other `impl:` identity — the honest
    // gap is the missing surface (W2.15 descriptors), NOT trust. A computation
    // with no summary is `incomplete-static-surface`, never
    // `untrusted-implementation` (the `action:…` shape it replaced).
    expect(classifyStaticActionServability(
      candidate({
        implementationFingerprint: "impl:cf:builtin/map:v1",
        completeActionScopeSummary: undefined,
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "incomplete-static-surface",
    });

    // With a complete summary the builtin fingerprint is fully servable —
    // proving the gate never special-cases the builtin shape.
    expect(classifyStaticActionServability(
      candidate({
        implementationFingerprint: "impl:cf:builtin/map:v1",
        completeActionScopeSummary: {
          ...candidate().completeActionScopeSummary as Record<string, unknown>,
          implementationFingerprint: "impl:cf:builtin/map:v1",
        },
      }),
      servedSpace,
    )).toEqual({
      status: "claim-ready",
      actionKind: "computation",
    });
  });

  it("leaves the :server-v1 effect fingerprint semantics unchanged", () => {
    // The server-executable subset keeps `:server-v1`; W2.11 must not perturb
    // it. An effect with no summary is still `unknown-effect-surface`, and a
    // complete one is still `broker-required` — identical to any other `impl:`
    // effect.
    expect(classifyStaticActionServability(
      candidate({
        actionKind: "effect",
        implementationFingerprint: "impl:cf:builtin/fetchText:server-v1",
        completeActionScopeSummary: undefined,
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "unknown-effect-surface",
    });
    expect(classifyStaticActionServability(
      candidate({
        actionKind: "effect",
        implementationFingerprint: "impl:cf:builtin/fetchText:server-v1",
        completeActionScopeSummary: {
          ...candidate().completeActionScopeSummary as Record<string, unknown>,
          implementationFingerprint: "impl:cf:builtin/fetchText:server-v1",
        },
      }),
      servedSpace,
    )).toEqual({
      status: "broker-required",
      actionKind: "effect",
    });
  });

  it("rejects malformed direct output surfaces", () => {
    expect(classifyStaticActionServability(
      withSummary({ directOutputs: [] }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "malformed-output-surface",
    });
    expect(classifyStaticActionServability(
      withSummary({
        directOutputs: [address("of:output", {
          path: ["value", "nested"],
        })],
      }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "malformed-output-surface",
    });
  });

  it("rejects user and session scoped surfaces", () => {
    const cases: Array<{
      candidate: StaticActionServabilityCandidate;
      reason: string;
    }> = [
      {
        candidate: withSummary({
          piece: address("of:piece", { scope: "user" }),
        }),
        reason: "non-space-piece-scope",
      },
      {
        candidate: withSummary({
          reads: [address("of:input", { scope: "session" })],
        }),
        reason: "non-space-read-scope",
      },
      {
        candidate: withSummary({
          writes: [address("of:output", { scope: "user" })],
        }),
        reason: "non-space-write-scope",
      },
    ];

    for (const testCase of cases) {
      expect(classifyStaticActionServability(
        testCase.candidate,
        servedSpace,
      )).toEqual({
        status: "unservable",
        reason: testCase.reason,
      });
    }
  });

  it("distinguishes foreign piece, read, and write surfaces", () => {
    const cases: Array<{
      candidate: StaticActionServabilityCandidate;
      reason: string;
    }> = [
      {
        candidate: candidate({ ownerSpace: foreignSpace }),
        reason: "foreign-owner-space",
      },
      {
        candidate: withSummary({
          piece: address("of:piece", { space: foreignSpace }),
        }),
        reason: "foreign-piece-space",
      },
      {
        candidate: withSummary({
          reads: [address("of:input", { space: foreignSpace })],
        }),
        reason: "foreign-read-space",
      },
      {
        candidate: withSummary({
          materializerWriteEnvelopes: [
            address("of:side-write", { space: foreignSpace }),
          ],
        }),
        reason: "foreign-write-space",
      },
    ];

    for (const testCase of cases) {
      expect(classifyStaticActionServability(
        testCase.candidate,
        servedSpace,
      )).toEqual({
        status: "unservable",
        reason: testCase.reason,
      });
    }
  });

  it("promotes user-scoped computation surfaces to user rank in a user lane", () => {
    // C1.5a: lane-parameterized classification. A user-scoped read, write, or
    // piece surface on a computation classifies claim-ready at user rank
    // instead of unserving.
    const cases = [
      withSummary({ reads: [address("of:input", { scope: "user" })] }),
      withSummary({
        writes: [address("of:output"), address("of:side", { scope: "user" })],
      }),
      withSummary({ piece: address("of:piece", { scope: "user" }) }),
    ];
    for (const testCase of cases) {
      expect(classifyStaticActionServability(
        testCase,
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "user",
      });
    }
  });

  it("keeps all-space computations byte-identical under a user lane", () => {
    // Space regression: with the lane enabled, an all-space surface must
    // produce exactly the space-only result shape (no contextRank field).
    expect(classifyStaticActionServability(
      candidate(),
      servedSpace,
      { userContext: true },
    )).toEqual({
      status: "claim-ready",
      actionKind: "computation",
    });
  });

  it("keeps session-scoped surfaces unservable under a user lane", () => {
    expect(classifyStaticActionServability(
      withSummary({ reads: [address("of:input", { scope: "session" })] }),
      servedSpace,
      { userContext: true },
    )).toEqual({
      status: "unservable",
      reason: "non-space-read-scope",
    });
    expect(classifyStaticActionServability(
      withSummary({ writes: [address("of:output", { scope: "session" })] }),
      servedSpace,
      { userContext: true },
    )).toEqual({
      status: "unservable",
      reason: "non-space-write-scope",
    });
  });

  it("classifies user-scoped effects broker-required at user rank (C2.8 lifts amendment 8)", () => {
    // C2.8 (2026-07-18): the lane promotes effects exactly like
    // computations — a user-scoped effect surface classifies
    // broker-required AT USER RANK under a user lane, and the broker
    // executes it under the lane grant (context-lattice §3/OQ6). The
    // reported rank drives the same CA9 lane routing as claim-ready.
    expect(classifyStaticActionServability(
      {
        ...candidate({ actionKind: "effect" }),
        completeActionScopeSummary: {
          ...candidate().completeActionScopeSummary as Record<string, unknown>,
          reads: [address("of:input", { scope: "user" })],
        },
      },
      servedSpace,
      { userContext: true },
    )).toEqual({
      status: "broker-required",
      actionKind: "effect",
      contextRank: "user",
    });
    // Session scope stays outside a USER lane's chain for effects exactly
    // as for computations (CA3's chain rule is rank-generic).
    expect(classifyStaticActionServability(
      {
        ...candidate({ actionKind: "effect" }),
        completeActionScopeSummary: {
          ...candidate().completeActionScopeSummary as Record<string, unknown>,
          reads: [address("of:input", { scope: "session" })],
        },
      },
      servedSpace,
      { userContext: true },
    )).toEqual({
      status: "unservable",
      reason: "non-space-read-scope",
    });
  });

  it("keeps scoped effect surfaces unservable without the lane (C2.8 regression)", () => {
    // No lane argument (and lane-off): byte-identical to the space-only
    // classifier — a scoped effect surface still unserves. The C2.8 lift is
    // lane-conditional, never ambient.
    for (
      const lane of [undefined, { userContext: false }] as const
    ) {
      expect(classifyStaticActionServability(
        {
          ...candidate({ actionKind: "effect" }),
          completeActionScopeSummary: {
            ...candidate().completeActionScopeSummary as Record<
              string,
              unknown
            >,
            reads: [address("of:input", { scope: "user" })],
          },
        },
        servedSpace,
        lane,
      )).toEqual({
        status: "unservable",
        reason: "non-space-read-scope",
      });
    }
  });

  it("keeps user-scoped surfaces unservable without the lane", () => {
    // Option off (no lane argument): byte-identical to the space-only
    // classifier — user scope still unserves.
    expect(classifyStaticActionServability(
      withSummary({ reads: [address("of:input", { scope: "user" })] }),
      servedSpace,
    )).toEqual({
      status: "unservable",
      reason: "non-space-read-scope",
    });
    expect(classifyStaticActionServability(
      withSummary({ reads: [address("of:input", { scope: "user" })] }),
      servedSpace,
      { userContext: false },
    )).toEqual({
      status: "unservable",
      reason: "non-space-read-scope",
    });
  });

  it("keeps handlers, UI writes, sources, and unknown actions client-primary", () => {
    const cases = [
      ["event-handler", "event-handler"],
      ["ui-binding", "ui-binding-transaction"],
      ["source", "source-transaction"],
      ["passthrough", "unknown-action-kind"],
    ] as const;

    for (const [actionKind, reason] of cases) {
      expect(classifyStaticActionServability(
        { actionKind },
        servedSpace,
      )).toEqual({ status: "unservable", reason });
    }
  });
});

// ---------------------------------------------------------------------------
// §4 output-widening pair (context-lattice C1.2/C1.9): a user-rank PerUser
// derivation writes its one logical output twice — the broad space instance
// as a scope-naming redirect link plus the value at the ACTING principal's
// user instance of the same document. The static classifier accepts the pair
// as one logical direct output; the dynamic firewall covers both legs from
// the certificate's broad direct output and keeps the engine's broad-value
// backstop. Everything outside that exact shape stays fail-closed, and the
// space lane keeps byte-identical space-only behavior.
//
// The acting principal is implicit at this seam: commit operations carry
// only the declared scope (`user`), and the effective `user:<did>` scope key
// is bound from the transaction's acting context by the host/engine seams
// (C1.4/C1.4b), which is where another principal's instance is rejected.
// What this seam CAN see — and pins fail-closed here — is the document
// identity (only the direct output's id widens), the scope axis (session
// never widens in C1), and the broad leg's wire shape.
// ---------------------------------------------------------------------------

describe("§4 output-widening pair servability (C1.9)", () => {
  const broadOutput = address("of:output");
  const userTwin = address("of:output", { scope: "user" });

  describe("static classification", () => {
    it("admits the §4 pair as the one logical direct output at user rank", () => {
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, userTwin],
          directOutputs: [broadOutput, userTwin],
        }),
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "user",
      });
      // Pair order is not significant.
      expect(classifyStaticActionServability(
        withSummary({
          writes: [userTwin, broadOutput],
          directOutputs: [userTwin, broadOutput],
        }),
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "user",
      });
    });

    it("lets the declared write name either instance of the §4 output", () => {
      expect(classifyStaticActionServability(
        withSummary({ writes: [userTwin], directOutputs: [broadOutput] }),
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "user",
      });
    });

    it("keeps the pair malformed without the user lane (space byte-identity)", () => {
      for (
        const lane of [undefined, { userContext: false }] as const
      ) {
        expect(classifyStaticActionServability(
          withSummary({
            writes: [broadOutput, userTwin],
            directOutputs: [broadOutput, userTwin],
          }),
          servedSpace,
          lane,
        )).toEqual({
          status: "unservable",
          reason: "malformed-output-surface",
        });
      }
    });

    it("never pairs across document ids", () => {
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, address("of:other", { scope: "user" })],
          directOutputs: [broadOutput, address("of:other", { scope: "user" })],
        }),
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
    });

    it("never pairs with a session instance (inadmissible until C2)", () => {
      const sessionTwin = address("of:output", { scope: "session" });
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, sessionTwin],
          directOutputs: [broadOutput, sessionTwin],
        }),
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
    });

    it("never collapses two same-scope outputs into a pair", () => {
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput],
          directOutputs: [broadOutput, address("of:output")],
        }),
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
    });

    it("never pairs instances whose document paths differ", () => {
      const deepTwin = address("of:output", {
        scope: "user",
        path: ["value", "nested"],
      });
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, deepTwin],
          directOutputs: [broadOutput, deepTwin],
        }),
        servedSpace,
        { userContext: true },
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
    });
  });

  describe("dynamic firewall", () => {
    // The wire-conformant broad leg: the document's cell tree carries the
    // shared conformance link at the fixture's document path (A7 — the same
    // value the engine accept tests admit and the runner emit test produces).
    const conformingBroadDocument = {
      value: { value: SCOPE_NAMING_LINK_CONFORMANCE.link },
    };

    function observation(
      overrides: Partial<SchedulerActionObservation> = {},
    ): SchedulerActionObservation {
      return {
        version: 2,
        ownerSpace: servedSpace,
        branch: "",
        pieceId: "space:of:piece",
        processGeneration: 1,
        actionId: "action-1",
        actionKind: "computation",
        implementationFingerprint: "impl:computation-v1",
        runtimeFingerprint: "runner:scheduler:v3",
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads: [address("of:input")],
        shallowReads: [],
        actualChangedWrites: [broadOutput, userTwin],
        currentKnownWrites: [],
        materializerWriteEnvelopes: [],
        completeActionScopeSummary: candidate()
          .completeActionScopeSummary as CompleteActionScopeSummary,
        status: "success",
        ...overrides,
      };
    }

    function routeInput(
      operations: ClientCommit["operations"],
      observed: SchedulerActionObservation,
    ): ActionTransactionRouteInput {
      return {
        space: servedSpace,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations,
          schedulerObservation: observed,
        },
        sourceAction: {},
      };
    }

    const pairOperations = (
      broadValue: unknown = conformingBroadDocument,
    ): ClientCommit["operations"] => [
      {
        op: "set",
        id: "of:output",
        scope: "space",
        value: broadValue as Record<string, never>,
      },
      { op: "set", id: "of:output", scope: "user", value: { value: 6 } },
    ];

    // The executor seam: user-rank commits act on the lane, so the §4 broad
    // scope-naming backstop applies (engine lockstep).
    const userContext = {
      servedSpace,
      branch: "",
      contextRank: "user",
      laneActingCommit: true,
    } as const;

    it("admits the widening pair under a user-rank lane", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(pairOperations(), observed),
        observed,
        userContext,
      )).toBeUndefined();
    });

    it("admits a patch-form broad leg only as an exact conforming link", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput([
          {
            op: "patch",
            id: "of:output",
            scope: "space",
            patches: [{
              op: "replace",
              path: "/value/value",
              value: SCOPE_NAMING_LINK_CONFORMANCE.link,
            }],
          },
          { op: "set", id: "of:output", scope: "user", value: { value: 6 } },
        ], observed),
        observed,
        userContext,
      )).toBeUndefined();
      // Positional patch kinds cannot prove the self-redirect property.
      expect(dynamicActionTransactionUnservableReason(
        routeInput([
          {
            op: "patch",
            id: "of:output",
            scope: "space",
            patches: [{
              op: "splice",
              path: "/value/value",
              index: 0,
              remove: 0,
              add: [SCOPE_NAMING_LINK_CONFORMANCE.link],
            }],
          },
        ], observed),
        observed,
        userContext,
      )).toBe("broad-lane-value-write");
    });

    it("rejects a broad VALUE write (§4 backstop)", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(pairOperations({ value: 6 }), observed),
        observed,
        userContext,
      )).toBe("broad-lane-value-write");
    });

    it("rejects a scope-naming link whose shape violates the wire contract", () => {
      const observed = observation();
      const link = SCOPE_NAMING_LINK_CONFORMANCE
        .link as unknown as { "/": { "link@1": Record<string, unknown> } };
      const cases: Array<Record<string, unknown>> = [
        // Schema-bearing: a per-lane covert channel.
        { ...link["/"]["link@1"], schema: { type: "number" } },
        // Foreign id: must name the written document itself.
        { ...link["/"]["link@1"], id: "of:other" },
        // Session scope: nonconforming until C2.
        { ...link["/"]["link@1"], scope: "session" },
        // Non-redirect overwrite.
        { ...link["/"]["link@1"], overwrite: "value" },
      ];
      for (const payload of cases) {
        expect(dynamicActionTransactionUnservableReason(
          routeInput(
            pairOperations({
              value: { value: { "/": { "link@1": payload } } },
            }),
            observed,
          ),
          observed,
          userContext,
        )).toBe("malformed-scope-naming-link");
      }
    });

    it("widens coverage only to the direct output's own document id", () => {
      // A user-scope value write to ANOTHER document never rides the pair:
      // both the observed-address arm and the commit-operation arm reject.
      const foreignUserWrite = address("of:other", { scope: "user" });
      const observedAddress = observation({
        actualChangedWrites: [broadOutput, userTwin, foreignUserWrite],
      });
      expect(dynamicActionTransactionUnservableReason(
        routeInput(pairOperations(), observedAddress),
        observedAddress,
        userContext,
      )).toBe("dynamic-write-outside-static-surface");
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput([
          ...pairOperations(),
          { op: "set", id: "of:other", scope: "user", value: { value: 1 } },
        ], observed),
        observed,
        userContext,
      )).toBe("dynamic-write-outside-static-surface");
    });

    it("keeps session-scope writes inadmissible under a user-rank lane", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput([
          ...pairOperations(),
          { op: "set", id: "of:output", scope: "session", value: { value: 6 } },
        ], observed),
        observed,
        userContext,
      )).toBe("dynamic-non-space-write-scope");
      const sessionObserved = observation({
        actualChangedWrites: [
          broadOutput,
          address("of:output", { scope: "session" }),
        ],
      });
      expect(dynamicActionTransactionUnservableReason(
        routeInput(pairOperations(), sessionObserved),
        sessionObserved,
        userContext,
      )).toBe("dynamic-non-space-write-scope");
    });

    it("keeps the space lane byte-identical: the pair never widens at space rank", () => {
      const observed = observation();
      for (
        const context of [
          { servedSpace, branch: "" },
          { servedSpace, branch: "", contextRank: "space" },
        ] as const
      ) {
        expect(dynamicActionTransactionUnservableReason(
          routeInput(pairOperations(), observed),
          observed,
          context,
        )).toBe("dynamic-non-space-write-scope");
      }
    });

    it("keeps an all-space commit admitted at space rank (regression)", () => {
      const observed = observation({ actualChangedWrites: [broadOutput] });
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          [{ op: "set", id: "of:output", scope: "space", value: { value: 6 } }],
          observed,
        ),
        observed,
        { servedSpace, branch: "" },
      )).toBeUndefined();
    });

    it("a broad delete is never a scope-naming link", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          [{ op: "delete", id: "of:output", scope: "space" }],
          observed,
        ),
        observed,
        userContext,
      )).toBe("broad-lane-value-write");
    });

    it("accepts the canonical builder output for a root self-redirect", () => {
      // scopeNamingLinkForPath([]) is the root-cell form of the same
      // contract; the firewall accepts any conforming document position.
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          pairOperations({ value: scopeNamingLinkForPath([]) }),
          observed,
        ),
        observed,
        userContext,
      )).toBeUndefined();
    });

    it("keeps the broad backstop off a client suppression mirror (A10)", () => {
      // A cooperative client's mirror checks a commit acting on the CLIENT's
      // own context (laneActingCommit absent): a broad value write there is
      // ordinary client-primary output, and a user-context claim over an
      // all-space surface must keep suppressing byte-identically.
      const observed = observation({ actualChangedWrites: [broadOutput] });
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          [{ op: "set", id: "of:output", scope: "space", value: { value: 6 } }],
          observed,
        ),
        observed,
        { servedSpace, branch: "", contextRank: "user" },
      )).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// C2.2 — session-lane surface classification and the §4 pair at session
// rank. The lattice (context-lattice §2: `space < user:<principal> <
// session:<principal>:<sessionId>`) makes a session lane's admissible scope
// set its OWN chain: session-scoped surfaces plus the lane principal's
// user-scoped surfaces — the broader-in-chain rule the C2 adversarial review
// mandates (CA3: "a session lane's chain includes user/space, and C2.2 must
// widen laneAdmitsScope to admit it"). Classification reports the NARROWEST
// admitted scope as the context rank ("session" wins over "user") so the
// C2.5 router can rank-filter candidates (CA9). Effects stay space-only
// (A8/C2.8), and the space and user lanes keep byte-identical pre-C2
// behavior.
//
// Scope is a NAME at this seam: addresses carry the scope axis only, never a
// principal or session id — the acting context binds the instance at the
// host/engine seams (C1.4/C2.4). Another session's instance is therefore
// unnameable here by construction, which the scope-keyed-address rejection
// below pins.
// ---------------------------------------------------------------------------

describe("session-lane servability (C2.2)", () => {
  const sessionLane = { sessionContext: true } as const;

  describe("static classification", () => {
    it("promotes session-scoped computation surfaces to session rank", () => {
      const cases = [
        withSummary({ reads: [address("of:input", { scope: "session" })] }),
        withSummary({
          writes: [
            address("of:output"),
            address("of:side", { scope: "session" }),
          ],
        }),
        withSummary({ piece: address("of:piece", { scope: "session" }) }),
      ];
      for (const testCase of cases) {
        expect(classifyStaticActionServability(
          testCase,
          servedSpace,
          sessionLane,
        )).toEqual({
          status: "claim-ready",
          actionKind: "computation",
          contextRank: "session",
        });
      }
    });

    it("admits user-scoped surfaces at user rank (broader-in-chain, CA3)", () => {
      // A session lane's chain includes its principal's user rank, so a
      // user-scoped surface is admissible — but the reported rank is the
      // narrowest scope actually observed (user, not session), which is what
      // lets the CA9 rank filter route the action to a user lane.
      expect(classifyStaticActionServability(
        withSummary({ reads: [address("of:input", { scope: "user" })] }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "user",
      });
    });

    it("reports session rank when user and session surfaces mix", () => {
      // Narrowest-of-observed wins regardless of surface order.
      expect(classifyStaticActionServability(
        withSummary({
          reads: [
            address("of:user-input", { scope: "user" }),
            address("of:session-input", { scope: "session" }),
          ],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "session",
      });
      expect(classifyStaticActionServability(
        withSummary({
          reads: [
            address("of:session-input", { scope: "session" }),
            address("of:user-input", { scope: "user" }),
          ],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "session",
      });
    });

    it("keeps all-space computations byte-identical under a session lane", () => {
      // No contextRank field at all — the space-only result shape.
      expect(classifyStaticActionServability(
        candidate(),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
      });
    });

    it("classifies scoped effects broker-required at the lane's rank (C2.8 lifts A8)", () => {
      // C2.8 (2026-07-18): a session lane promotes effects exactly like
      // computations. A session-scoped effect surface classifies
      // broker-required AT SESSION RANK — the OQ6 scoped-lane builtin, the
      // lane principal's own standing side effect (context-lattice §3).
      expect(classifyStaticActionServability(
        {
          ...candidate({ actionKind: "effect" }),
          completeActionScopeSummary: {
            ...candidate().completeActionScopeSummary as Record<
              string,
              unknown
            >,
            reads: [address("of:input", { scope: "session" })],
          },
        },
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "broker-required",
        actionKind: "effect",
        contextRank: "session",
      });
      // The chain-read rule is rank-generic (CA3): a session-lane effect
      // reading the principal's USER-scoped input reports user rank —
      // narrowest-of-observed, identical to computations.
      expect(classifyStaticActionServability(
        {
          ...candidate({ actionKind: "effect" }),
          completeActionScopeSummary: {
            ...candidate().completeActionScopeSummary as Record<
              string,
              unknown
            >,
            reads: [address("of:input", { scope: "user" })],
          },
        },
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "broker-required",
        actionKind: "effect",
        contextRank: "user",
      });
      // An all-space effect keeps its ordinary broker arm — no contextRank
      // field at all, the space-only result shape byte-identical.
      expect(classifyStaticActionServability(
        candidate({ actionKind: "effect" }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "broker-required",
        actionKind: "effect",
      });
    });

    it("keeps session scope unservable under space and user lanes (regression)", () => {
      const sessionRead = withSummary({
        reads: [address("of:input", { scope: "session" })],
      });
      for (
        const lane of [
          undefined,
          { userContext: false },
          { userContext: true },
          { sessionContext: false },
          { sessionContext: false, userContext: true },
        ] as const
      ) {
        expect(classifyStaticActionServability(
          sessionRead,
          servedSpace,
          lane,
        )).toEqual({
          status: "unservable",
          reason: "non-space-read-scope",
        });
      }
    });

    it("cannot name another session: a scope-keyed address is malformed", () => {
      // Addresses carry the scope NAME only; smuggling a resolved scope key
      // (the only way to name a foreign session at this seam) fails the
      // address shape check.
      expect(classifyStaticActionServability(
        withSummary({
          reads: [{
            ...address("of:input", { scope: "session" }),
            scopeKey: "session:alice:s1",
          }],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "unservable",
        reason: "malformed-static-surface",
      });
    });
  });

  describe("§4 output-widening pair at session rank", () => {
    const broadOutput = address("of:output");
    const sessionTwin = address("of:output", { scope: "session" });
    const userTwin = address("of:output", { scope: "user" });

    it("admits the broad+session pair as the one logical direct output", () => {
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, sessionTwin],
          directOutputs: [broadOutput, sessionTwin],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "session",
      });
      // Pair order is not significant.
      expect(classifyStaticActionServability(
        withSummary({
          writes: [sessionTwin, broadOutput],
          directOutputs: [sessionTwin, broadOutput],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "session",
      });
    });

    it("lets the declared write name either instance of the §4 output", () => {
      expect(classifyStaticActionServability(
        withSummary({ writes: [sessionTwin], directOutputs: [broadOutput] }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "session",
      });
    });

    it("still admits the user pair under a session lane at user rank (chain rule)", () => {
      // A user-rank action's §4 pair (broad + user instance) stays a valid
      // shape under a session lane — its surfaces are broader-in-chain — and
      // classifies at USER rank for the CA9 rank filter.
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, userTwin],
          directOutputs: [broadOutput, userTwin],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "user",
      });
    });

    it("never collapses a scoped-scoped pair without the broad leg", () => {
      expect(classifyStaticActionServability(
        withSummary({
          writes: [userTwin, sessionTwin],
          directOutputs: [userTwin, sessionTwin],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
    });

    it("keeps the session pair malformed under space and user lanes (regression)", () => {
      for (
        const lane of [undefined, { userContext: true }] as const
      ) {
        expect(classifyStaticActionServability(
          withSummary({
            writes: [broadOutput, sessionTwin],
            directOutputs: [broadOutput, sessionTwin],
          }),
          servedSpace,
          lane,
        )).toEqual({
          status: "unservable",
          reason: "malformed-output-surface",
        });
      }
    });

    it("never pairs across document ids or differing paths at session rank", () => {
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, address("of:other", { scope: "session" })],
          directOutputs: [
            broadOutput,
            address("of:other", { scope: "session" }),
          ],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
      const deepTwin = address("of:output", {
        scope: "session",
        path: ["value", "nested"],
      });
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, deepTwin],
          directOutputs: [broadOutput, deepTwin],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
    });

    it("never collapses three output instances", () => {
      expect(classifyStaticActionServability(
        withSummary({
          writes: [broadOutput, userTwin, sessionTwin],
          directOutputs: [broadOutput, userTwin, sessionTwin],
        }),
        servedSpace,
        sessionLane,
      )).toEqual({
        status: "unservable",
        reason: "malformed-output-surface",
      });
    });
  });

  describe("dynamic firewall at session rank", () => {
    const broadOutput = address("of:output");
    const sessionTwin = address("of:output", { scope: "session" });

    // The wire-conformant broad leg for a session-rank pair: the shared
    // session conformance link at the fixture's document path (A7 — the
    // same JSON the runner emit test captures and the engine accept side
    // consumes).
    const conformingBroadDocument = {
      value: { value: SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link },
    };

    function observation(
      overrides: Partial<SchedulerActionObservation> = {},
    ): SchedulerActionObservation {
      return {
        version: 2,
        ownerSpace: servedSpace,
        branch: "",
        pieceId: "space:of:piece",
        processGeneration: 1,
        actionId: "action-1",
        actionKind: "computation",
        implementationFingerprint: "impl:computation-v1",
        runtimeFingerprint: "runner:scheduler:v3",
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads: [address("of:input")],
        shallowReads: [],
        actualChangedWrites: [broadOutput, sessionTwin],
        currentKnownWrites: [],
        materializerWriteEnvelopes: [],
        completeActionScopeSummary: candidate()
          .completeActionScopeSummary as CompleteActionScopeSummary,
        status: "success",
        ...overrides,
      };
    }

    function routeInput(
      operations: ClientCommit["operations"],
      observed: SchedulerActionObservation,
    ): ActionTransactionRouteInput {
      return {
        space: servedSpace,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations,
          schedulerObservation: observed,
        },
        sourceAction: {},
      };
    }

    const pairOperations = (
      broadValue: unknown = conformingBroadDocument,
    ): ClientCommit["operations"] => [
      {
        op: "set",
        id: "of:output",
        scope: "space",
        value: broadValue as Record<string, never>,
      },
      { op: "set", id: "of:output", scope: "session", value: { value: 6 } },
    ];

    // The executor seam: session-rank commits act on the lane, so the §4
    // broad scope-naming backstop applies (engine lockstep).
    const sessionContext = {
      servedSpace,
      branch: "",
      contextRank: "session",
      laneActingCommit: true,
    } as const;

    it("admits the session widening pair under a session-rank lane", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(pairOperations(), observed),
        observed,
        sessionContext,
      )).toBeUndefined();
    });

    it("admits session- and user-scoped dynamic reads of the lane's own chain", () => {
      // CA3's broader-in-chain rule at the dynamic seam: both the lane's own
      // session-scoped reads and its principal's user-scoped reads admit.
      const observed = observation({
        reads: [
          address("of:input"),
          address("of:session-input", { scope: "session" }),
          address("of:user-input", { scope: "user" }),
        ],
      });
      const input = routeInput(pairOperations(), observed);
      input.commit.reads.confirmed.push(
        {
          id: "of:session-input",
          scope: "session",
          path: toDocumentPath(["value"]),
          seq: 1,
        },
        {
          id: "of:user-input",
          scope: "user",
          path: toDocumentPath(["value"]),
          seq: 1,
        },
      );
      expect(dynamicActionTransactionUnservableReason(
        input,
        observed,
        sessionContext,
      )).toBeUndefined();
    });

    it("rejects a broad VALUE write (§4 backstop at session rank)", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(pairOperations({ value: 6 }), observed),
        observed,
        sessionContext,
      )).toBe("broad-lane-value-write");
    });

    it("a broad delete is never a scope-naming link", () => {
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          [{ op: "delete", id: "of:output", scope: "space" }],
          observed,
        ),
        observed,
        sessionContext,
      )).toBe("broad-lane-value-write");
    });

    it("accepts a broad link naming the user scope (broader-in-chain naming)", () => {
      // A session lane's chain includes user rank, so a user-rank action's
      // conforming link is admissible under a session-rank commit — it is
      // byte-identical to what every user lane writes at that address.
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          pairOperations({
            value: { value: SCOPE_NAMING_LINK_CONFORMANCE.link },
          }),
          observed,
        ),
        observed,
        sessionContext,
      )).toBeUndefined();
    });

    it("rejects a link naming a session id or carrying one (both directions)", () => {
      // The link VALUE names only the scope — never a session id. A payload
      // whose scope smuggles the resolved key, or that carries a sessionId
      // field, is malformed at the wire contract.
      const observed = observation();
      const link = SESSION_SCOPE_NAMING_LINK_CONFORMANCE
        .link as unknown as { "/": { "link@1": Record<string, unknown> } };
      const cases: Array<Record<string, unknown>> = [
        { ...link["/"]["link@1"], scope: "session:alice:s1" },
        { ...link["/"]["link@1"], sessionId: "s1" },
        { ...link["/"]["link@1"], scope: "space" },
        { ...link["/"]["link@1"], schema: { type: "number" } },
        { ...link["/"]["link@1"], id: "of:other" },
        { ...link["/"]["link@1"], overwrite: "value" },
      ];
      for (const payload of cases) {
        expect(dynamicActionTransactionUnservableReason(
          routeInput(
            pairOperations({
              value: { value: { "/": { "link@1": payload } } },
            }),
            observed,
          ),
          observed,
          sessionContext,
        )).toBe("malformed-scope-naming-link");
      }
    });

    it("widens coverage only to the direct output's own document id", () => {
      const foreignSessionWrite = address("of:other", { scope: "session" });
      const observedAddress = observation({
        actualChangedWrites: [broadOutput, sessionTwin, foreignSessionWrite],
      });
      expect(dynamicActionTransactionUnservableReason(
        routeInput(pairOperations(), observedAddress),
        observedAddress,
        sessionContext,
      )).toBe("dynamic-write-outside-static-surface");
      const observed = observation();
      expect(dynamicActionTransactionUnservableReason(
        routeInput([
          ...pairOperations(),
          { op: "set", id: "of:other", scope: "session", value: { value: 1 } },
        ], observed),
        observed,
        sessionContext,
      )).toBe("dynamic-write-outside-static-surface");
    });

    it("keeps session scope inadmissible under user and space ranks (regression)", () => {
      // The session pair rejects in EVERY narrower lane, with the code of
      // the first check it fails: at space rank the session-instance write
      // is out of scope; at user rank the broad leg's session-named link is
      // cross-lane at the backstop (operations run in order, broad first).
      const observed = observation();
      for (
        const [context, reason] of [
          [{ servedSpace, branch: "" }, "dynamic-non-space-write-scope"],
          [
            { servedSpace, branch: "", contextRank: "space" },
            "dynamic-non-space-write-scope",
          ],
          [
            {
              servedSpace,
              branch: "",
              contextRank: "user",
              laneActingCommit: true,
            },
            "malformed-scope-naming-link",
          ],
        ] as const
      ) {
        expect(dynamicActionTransactionUnservableReason(
          routeInput(pairOperations(), observed),
          observed,
          context,
        )).toBe(reason);
      }
      // Order-independence of the rejection: session-instance op first
      // rejects out-of-scope at user rank too.
      expect(dynamicActionTransactionUnservableReason(
        routeInput([...pairOperations()].reverse(), observed),
        observed,
        {
          servedSpace,
          branch: "",
          contextRank: "user",
          laneActingCommit: true,
        },
      )).toBe("dynamic-non-space-write-scope");
    });

    it("keeps the broad backstop off a client suppression mirror (A10)", () => {
      // A cooperative client's mirror checks a commit acting on the CLIENT's
      // own context (laneActingCommit absent): a broad value write there is
      // ordinary client-primary output.
      const observed = observation({ actualChangedWrites: [broadOutput] });
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          [{ op: "set", id: "of:output", scope: "space", value: { value: 6 } }],
          observed,
        ),
        observed,
        { servedSpace, branch: "", contextRank: "session" },
      )).toBeUndefined();
    });

    it("applies the backstop to EVERY broad write of a session-acting commit", () => {
      // Engine lockstep: a session-rank lane-acting commit may write a broad
      // document only as the conforming scope-naming link — a broad VALUE
      // write means output-scoping failed, exactly as at user rank.
      const observed = observation({ actualChangedWrites: [broadOutput] });
      expect(dynamicActionTransactionUnservableReason(
        routeInput(
          [{ op: "set", id: "of:output", scope: "space", value: { value: 6 } }],
          observed,
        ),
        observed,
        sessionContext,
      )).toBe("broad-lane-value-write");
      expect(dynamicActionTransactionUnservableReason(
        routeInput([{
          op: "set",
          id: "of:output",
          scope: "space",
          value: conformingBroadDocument as unknown as Record<string, never>,
        }], observed),
        observed,
        sessionContext,
      )).toBeUndefined();
    });
  });
});

describe("chain-scoped claim keys (C1.6)", () => {
  const chainKey: ActionClaimKey = {
    branch: "branch-a",
    space: servedSpace,
    contextKey: "space",
    pieceId: "space:of:piece",
    actionId: "action:compute",
    actionKind: "computation",
    implementationFingerprint: "impl:computation-v1",
    runtimeFingerprint: "runner:scheduler:v3",
  };
  // A18: colon-bearing did:key principals end-to-end, only ever encoded
  // through the canonical helpers.
  const myDid = "did:key:z6MkChainScopedRoutingMe";
  const mySessionId = "session:chain-scoped";
  const chain = ownChainContextKeys(myDid, mySessionId);
  const liveClaim = (
    contextKey: ExecutionClaim["contextKey"],
  ): ExecutionClaim => ({
    ...chainKey,
    contextKey,
    leaseGeneration: 1,
    claimGeneration: 1,
    expiresAt: 10_000,
  });

  it("keys one logical action identically across every context", () => {
    const base = actionClaimChainMapKey(chainKey);
    expect(actionClaimChainMapKey({
      ...chainKey,
      contextKey: userExecutionContextKey(myDid),
    })).toEqual(base);
    expect(actionClaimChainMapKey({
      ...chainKey,
      contextKey: sessionExecutionContextKey(myDid, mySessionId),
    })).toEqual(base);
    // The chain representative reuses the canonical protocol encoding: for a
    // space-context key the chain map key IS the full map key.
    expect(base).toEqual(actionClaimMapKey(chainKey));
  });

  it("separates chain keys on every non-context field", () => {
    const base = actionClaimChainMapKey(chainKey);
    const variants: Partial<ActionClaimKey>[] = [
      { branch: "branch-b" },
      { space: foreignSpace },
      { pieceId: "space:of:other" },
      { actionId: "action:other" },
      { actionKind: "effect" },
      { implementationFingerprint: "impl:other" },
      { runtimeFingerprint: "runner:other" },
    ];
    for (const variant of variants) {
      expect(actionClaimChainMapKey({ ...chainKey, ...variant })).not.toEqual(
        base,
      );
    }
  });

  it("builds the full own chain from the canonical helpers", () => {
    expect([...chain]).toEqual([
      "space",
      userExecutionContextKey(myDid),
      sessionExecutionContextKey(myDid, mySessionId),
    ]);
    // Naive concatenation of a colon-bearing DID is never canonical.
    expect(chain.has(`user:${myDid}`)).toBe(false);
    expect(chain.has(`session:${myDid}:${mySessionId}`)).toBe(false);
  });

  it("accepts exactly the own-chain contexts for a chain-matching claim", () => {
    for (
      const contextKey of [
        "space" as const,
        userExecutionContextKey(myDid),
        sessionExecutionContextKey(myDid, mySessionId),
      ]
    ) {
      expect(executionClaimMatchesActionChain(
        liveClaim(contextKey),
        chainKey,
        chain,
      )).toBe(true);
    }
    for (
      const contextKey of [
        userExecutionContextKey("did:key:z6MkChainScopedRoutingOther"),
        sessionExecutionContextKey(myDid, "session:other"),
        `user:${myDid}` as ExecutionClaim["contextKey"],
      ]
    ) {
      expect(executionClaimMatchesActionChain(
        liveClaim(contextKey),
        chainKey,
        chain,
      )).toBe(false);
    }
  });

  it("never chain-matches a claim for a different action", () => {
    expect(executionClaimMatchesActionChain(
      { ...liveClaim("space"), actionId: "action:other" },
      chainKey,
      chain,
    )).toBe(false);
  });
});

// W2.12's promised runtime-floor guarantee (FB30): the read-only certificate
// relaxation is sound only because a session-scoped dynamic read through an
// opaque param still narrows the RUNTIME context floor — the trusted
// certificate must never defeat that narrowing. Exercised against the real
// memory engine (the floor is computed inside `upsertSchedulerObservation`),
// because the certified-plus-scoped-observed-read combination is exactly what
// the W2.12 relaxation newly made reachable.
describe("runtime context floor with a read-only certificate (W2.12/FB30)", () => {
  const OWNER = "did:key:runtime-floor-owner";
  const PRINCIPAL = "did:key:runtime-floor-alice";
  const SESSION_ID = "runtime-floor-session-a";

  const floorAddress = (
    id: string,
    scope: "space" | "user" | "session",
  ) => ({ space: OWNER, id, scope, path: ["value"] });

  // A certified READ-ONLY computation: the complete summary enumerates only
  // space-scoped surfaces (static floor: space). The observed runtime read
  // set carries the opaque-param read at its RESOLVED scope.
  const observationWithRuntimeRead = (
    runtimeReadScope: "space" | "session",
  ) => {
    const summaryRead = floorAddress("of:input", "space");
    const summaryWrite = floorAddress("of:output", "space");
    return {
      version: 2,
      ownerSpace: OWNER,
      branch: "",
      pieceId: "space:piece",
      processGeneration: 1,
      actionId: "action:runtime-floor",
      actionKind: "computation",
      implementationFingerprint: "impl:runtime-floor-v1",
      runtimeFingerprint: "runtime:v1",
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint: "impl:runtime-floor-v1",
        runtimeFingerprint: "runtime:v1",
        piece: { space: OWNER, id: "piece", scope: "space", path: [] },
        reads: [summaryRead],
        writes: [summaryWrite],
        materializerWriteEnvelopes: [],
        directOutputs: [summaryWrite],
      },
      observedAtSeq: 0,
      transactionKind: "action-run",
      reads: [
        summaryRead,
        // The opaque-param read at its runtime-resolved scope: the
        // certificate never enumerated it, and C0 admits it dynamically.
        floorAddress("of:opaque-param-target", runtimeReadScope),
      ],
      shallowReads: [],
      actualChangedWrites: [],
      currentKnownWrites: [summaryWrite],
      materializerWriteEnvelopes: [],
      ignoredSchedulingWrites: [],
      actionOptions: {},
      status: "success",
    };
  };

  const withFloorEngine = async (
    run: (
      engine: import("../../memory/v2/engine.ts").Engine,
    ) => void | Promise<void>,
  ): Promise<void> => {
    const { open, close } = await import("../../memory/v2/engine.ts");
    const { toFileUrl } = await import("@std/path");
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({ url: toFileUrl(path) });
    try {
      await run(engine);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  };

  it("a session-scoped opaque-param read narrows the floor to session rank despite the certificate", async () => {
    const { upsertSchedulerObservation } = await import(
      "../../memory/v2/engine.ts"
    );
    await withFloorEngine((engine) => {
      const result = upsertSchedulerObservation(engine, {
        ownerSpace: OWNER,
        observedAtSeq: 0,
        observation: observationWithRuntimeRead(
          "session",
        ) as unknown as Parameters<
          typeof upsertSchedulerObservation
        >[1]["observation"],
        scopeContext: { principal: PRINCIPAL, sessionId: SESSION_ID },
      });
      // The runtime floor, not the certificate's space-rank static floor,
      // decides the execution context: session rank for this principal.
      expect(result.executionContextKey).toBe(
        sessionExecutionContextKey(PRINCIPAL, SESSION_ID),
      );
    });
  });

  it("control: the same certified action with space-scoped observed reads keeps the space floor", async () => {
    const { upsertSchedulerObservation } = await import(
      "../../memory/v2/engine.ts"
    );
    await withFloorEngine((engine) => {
      const result = upsertSchedulerObservation(engine, {
        ownerSpace: OWNER,
        observedAtSeq: 0,
        observation: observationWithRuntimeRead(
          "space",
        ) as unknown as Parameters<
          typeof upsertSchedulerObservation
        >[1]["observation"],
        scopeContext: { principal: PRINCIPAL, sessionId: SESSION_ID },
      });
      expect(result.executionContextKey).toBe("space");
    });
  });
});

// ---------------------------------------------------------------------------
// C3.6 cross-space-read servability: the `foreign-read-space` reject becomes a
// stage-gated, space-scoped admission carrying a `crossSpaceReadSpaces`
// capability, while foreign WRITES / scoped-foreign reads / foreign owner+piece
// stay rejected byte-identically (decision #3). Both classifiers mirror.
// ---------------------------------------------------------------------------
describe("C3.6 cross-space-read servability", () => {
  const otherForeign = "did:key:foreign-b" as const;
  const foreignRead = (scope: "space" | "user" | "session" = "space") =>
    address("of:foreign-input", { space: foreignSpace, scope });

  describe("static classifier", () => {
    it("stage OFF: a space-scoped foreign read stays foreign-read-space", () => {
      const c = withSummary({ reads: [address("of:input"), foreignRead()] });
      // Omitted and explicit-false are identical to the pre-C3.6 verdict.
      expect(classifyStaticActionServability(c, servedSpace)).toEqual({
        status: "unservable",
        reason: "foreign-read-space",
      });
      expect(
        classifyStaticActionServability(c, servedSpace, undefined, false),
      ).toEqual({ status: "unservable", reason: "foreign-read-space" });
    });

    it("stage ON: a space-scoped foreign read is claim-ready carrying its space", () => {
      const c = withSummary({ reads: [address("of:input"), foreignRead()] });
      expect(
        classifyStaticActionServability(c, servedSpace, undefined, true),
      ).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        crossSpaceReadSpaces: [foreignSpace],
      });
    });

    it("stage ON: multiple foreign reads dedup and sort into the capability", () => {
      const c = withSummary({
        reads: [
          address("of:input"),
          address("of:f1", { space: otherForeign }),
          address("of:f2", { space: foreignSpace }),
          address("of:f3", { space: foreignSpace }), // dup space, deduped
        ],
      });
      const result = classifyStaticActionServability(
        c,
        servedSpace,
        undefined,
        true,
      );
      expect(result.status).toBe("claim-ready");
      // Sorted for a stable claim key: "did:key:foreign" < "did:key:foreign-b".
      expect(
        (result as { crossSpaceReadSpaces?: readonly string[] })
          .crossSpaceReadSpaces,
      ).toEqual([foreignSpace, otherForeign].toSorted());
    });

    it("stage ON: a scoped (user/session) foreign read stays rejected (decision #3)", () => {
      for (const scope of ["user", "session"] as const) {
        const c = withSummary({
          reads: [address("of:input"), foreignRead(scope)],
        });
        expect(
          classifyStaticActionServability(c, servedSpace, undefined, true),
        ).toEqual({ status: "unservable", reason: "foreign-read-scope" });
      }
    });

    it("stage ON: foreign WRITE / owner / piece stay rejected byte-identically", () => {
      expect(
        classifyStaticActionServability(
          withSummary({
            materializerWriteEnvelopes: [
              address("of:side-write", { space: foreignSpace }),
            ],
          }),
          servedSpace,
          undefined,
          true,
        ),
      ).toEqual({ status: "unservable", reason: "foreign-write-space" });
      expect(
        classifyStaticActionServability(
          candidate({ ownerSpace: foreignSpace }),
          servedSpace,
          undefined,
          true,
        ),
      ).toEqual({ status: "unservable", reason: "foreign-owner-space" });
      expect(
        classifyStaticActionServability(
          withSummary({ piece: address("of:piece", { space: foreignSpace }) }),
          servedSpace,
          undefined,
          true,
        ),
      ).toEqual({ status: "unservable", reason: "foreign-piece-space" });
    });

    it("stage ON but no foreign read: byte-identical claim-ready (no capability field)", () => {
      expect(
        classifyStaticActionServability(
          candidate(),
          servedSpace,
          undefined,
          true,
        ),
      ).toEqual({ status: "claim-ready", actionKind: "computation" });
    });

    it("cross-space-read composes ORTHOGONALLY with a user lane (both fields)", () => {
      const c = withSummary({
        reads: [address("of:input", { scope: "user" }), foreignRead()],
      });
      expect(
        classifyStaticActionServability(
          c,
          servedSpace,
          { userContext: true },
          true,
        ),
      ).toEqual({
        status: "claim-ready",
        actionKind: "computation",
        contextRank: "user",
        crossSpaceReadSpaces: [foreignSpace],
      });
    });
  });

  describe("dynamic firewall mirror", () => {
    function observation(
      reads: IMemorySpaceAddress[],
    ): SchedulerActionObservation {
      const output = address("of:output");
      return {
        version: 2,
        ownerSpace: servedSpace,
        branch: "",
        pieceId: "space:of:piece",
        processGeneration: 1,
        actionId: "action-1",
        actionKind: "computation",
        implementationFingerprint: "impl:computation-v1",
        runtimeFingerprint: "runner:scheduler:v3",
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads,
        shallowReads: [],
        actualChangedWrites: [output],
        currentKnownWrites: [output],
        declaredWrites: [output],
        materializerWriteEnvelopes: [],
        completeActionScopeSummary: candidate()
          .completeActionScopeSummary as CompleteActionScopeSummary,
        status: "success",
      };
    }

    const routeInput = (
      observed: SchedulerActionObservation,
    ): ActionTransactionRouteInput => ({
      space: servedSpace,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:output", scope: "space", value: { value: 1 } },
        ],
        schedulerObservation: observed,
      },
      sourceAction: {},
    });

    const spaceContext = (crossSpaceRead: boolean) => ({
      servedSpace,
      branch: "",
      crossSpaceRead,
    });

    it("stage OFF: an observed space-scoped foreign read is dynamic-foreign-read-space", () => {
      const observed = observation([address("of:input"), foreignRead()]);
      expect(
        dynamicActionTransactionUnservableReason(
          routeInput(observed),
          observed,
          spaceContext(false),
        ),
      ).toBe("dynamic-foreign-read-space");
    });

    it("stage ON: an observed space-scoped foreign read is admitted", () => {
      const observed = observation([address("of:input"), foreignRead()]);
      expect(
        dynamicActionTransactionUnservableReason(
          routeInput(observed),
          observed,
          spaceContext(true),
        ),
      ).toBeUndefined();
    });

    it("stage ON: an observed scoped foreign read is dynamic-foreign-read-scope", () => {
      const observed = observation([address("of:input"), foreignRead("user")]);
      expect(
        dynamicActionTransactionUnservableReason(
          routeInput(observed),
          observed,
          spaceContext(true),
        ),
      ).toBe("dynamic-foreign-read-scope");
    });

    it("an observed foreign WRITE stays dynamic-foreign-write-space at both stages", () => {
      for (const stage of [false, true]) {
        const observed = observation([address("of:input")]);
        observed.actualChangedWrites = [
          address("of:output", { space: foreignSpace }),
        ];
        expect(
          dynamicActionTransactionUnservableReason(
            routeInput(observed),
            observed,
            spaceContext(stage),
          ),
        ).toBe("dynamic-foreign-write-space");
      }
    });
  });
});

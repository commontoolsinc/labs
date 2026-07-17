import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type ClientCommit,
  type ExecutionClaim,
  sessionExecutionContextKey,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import {
  SCOPE_NAMING_LINK_CONFORMANCE,
  scopeNamingLinkForPath,
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

  it("keeps user-scoped effects unservable under a user lane (amendment 8)", () => {
    // Effects stay space-lane in C1: the lane never promotes a
    // non-computation action, so a user-scoped effect surface unserves
    // exactly as it does without the lane.
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
      status: "unservable",
      reason: "non-space-read-scope",
    });
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

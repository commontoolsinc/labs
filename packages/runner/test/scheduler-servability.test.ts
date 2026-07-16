import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type ActionClaimKey,
  actionClaimMapKey,
  type ExecutionClaim,
  sessionExecutionContextKey,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import {
  classifyStaticActionServability,
  type StaticActionServabilityCandidate,
} from "../src/scheduler.ts";
import {
  actionClaimChainMapKey,
  executionClaimMatchesActionChain,
  ownChainContextKeys,
} from "../src/scheduler/servability.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

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

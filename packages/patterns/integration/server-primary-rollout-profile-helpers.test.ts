import { assertEquals, assertThrows } from "@std/assert";
import {
  type ActionClaimKey,
  type ExecutionClaim,
  toAcceptedCommitSeq,
  toInputBasisSeq,
} from "@commonfabric/memory/v2";
import type {
  ExecutionRoutingActionDiagnostics,
  ExecutionRoutingDiagnostics,
} from "@commonfabric/runner/shared";
import {
  assertAuthoritativePreflightSettlement,
  assertExactRoutingPhase,
  discoverScopedWritingAction,
} from "./server-primary-rollout-profile-helpers.ts";

const SPACE = "did:key:z6Mktest" as const;
const key: ActionClaimKey = {
  branch: "",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:of:rollout-piece",
  actionId: "action:doubled",
  actionKind: "computation",
  implementationFingerprint: "implementation:test",
  runtimeFingerprint: "runtime:test",
};

const claim: ExecutionClaim = {
  ...key,
  leaseGeneration: 3,
  claimGeneration: 5,
  expiresAt: 10_000,
};

const action = (
  overrides: Partial<ExecutionRoutingActionDiagnostics> = {},
): ExecutionRoutingActionDiagnostics => ({
  key,
  liveClaim: claim,
  upstreamRoutes: 0,
  claimedOverlayRoutes: 4,
  settlements: { committed: 3, noOp: 1, failed: 0, unserved: 0 },
  basisCoveredOverlayDrops: 4,
  nonAuthoritativeOverlayDrops: 0,
  pendingOverlayCount: 0,
  unresolvedBasisOverlayCount: 0,
  pendingSettlementCount: 0,
  lastSettlement: {
    branch: key.branch,
    claim,
    inputBasisSeq: toInputBasisSeq(18),
    outcome: "committed",
    acceptedCommitSeq: toAcceptedCommitSeq(19),
  },
  ...overrides,
});

const diagnostics = (
  overrides: Partial<ExecutionRoutingDiagnostics> = {},
): ExecutionRoutingDiagnostics => ({
  space: SPACE,
  branch: key.branch,
  executionFeedSeq: 30,
  executionAppliedSeq: 20,
  snapshotRequired: false,
  claims: [claim],
  actions: [action()],
  branchTotals: {
    upstreamRoutes: 0,
    claimedOverlayRoutes: 4,
    settlements: { committed: 3, noOp: 1, failed: 0, unserved: 0 },
    basisCoveredOverlayDrops: 4,
    nonAuthoritativeOverlayDrops: 0,
    settlementDiagnostics: {},
  },
  truncatedActionRecords: 0,
  ...overrides,
});

Deno.test("discovers exactly one claimed action that wrote in the actor trace", () => {
  const discovered = discoverScopedWritingAction(
    [
      { actionId: "event:increment", actualWrites: [{ entityId: "input" }] },
      { actionId: key.actionId, actualWrites: [{ entityId: "doubled" }] },
      { actionId: "action:read-only", actualWrites: [] },
    ],
    diagnostics(),
    "doubled",
  );

  assertEquals(discovered.key, key);
  assertEquals(discovered.claim, claim);
});

Deno.test("action discovery ignores a claimed writer for another result entity", () => {
  const otherClaim: ExecutionClaim = {
    ...claim,
    actionId: "action:other-writer",
  };
  const discovered = discoverScopedWritingAction(
    [
      { actionId: key.actionId, actualWrites: [{ entityId: "doubled" }] },
      {
        actionId: otherClaim.actionId,
        actualWrites: [{ entityId: "other" }],
      },
    ],
    diagnostics({
      claims: [claim, otherClaim],
      actions: [
        action(),
        action({ key: otherClaim, liveClaim: otherClaim }),
      ],
    }),
    "doubled",
  );
  assertEquals(discovered.key, key);
});

Deno.test("action discovery ignores an unclaimed writer for the exact result entity", () => {
  const unclaimedKey: ActionClaimKey = {
    ...key,
    actionId: "action:unclaimed-writer",
  };
  const discovered = discoverScopedWritingAction(
    [
      { actionId: key.actionId, actualWrites: [{ entityId: "doubled" }] },
      {
        actionId: unclaimedKey.actionId,
        actualWrites: [{ entityId: "doubled" }],
      },
    ],
    diagnostics({
      actions: [
        action(),
        action({ key: unclaimedKey, liveClaim: undefined }),
      ],
    }),
    "doubled",
  );
  assertEquals(discovered.key, key);
});

Deno.test("action discovery rejects two claimed writers for the exact result entity", () => {
  const otherClaim: ExecutionClaim = {
    ...claim,
    actionId: "action:other-writer",
  };
  assertThrows(
    () =>
      discoverScopedWritingAction(
        [
          { actionId: key.actionId, actualWrites: [{ entityId: "doubled" }] },
          {
            actionId: otherClaim.actionId,
            actualWrites: [{ entityId: "doubled" }],
          },
        ],
        diagnostics({
          claims: [claim, otherClaim],
          actions: [
            action(),
            action({ key: otherClaim, liveClaim: otherClaim }),
          ],
        }),
        "doubled",
      ),
    Error,
    "exactly one",
  );
});

Deno.test("routing phases treat feed and applied sequences as independent domains", () => {
  assertExactRoutingPhase(diagnostics(), {
    key,
    authoritative: true,
    events: 4,
  });
});

Deno.test("routing phases wait for an accepted commit to reach the data sequence", () => {
  assertThrows(
    () =>
      assertExactRoutingPhase(diagnostics({ executionAppliedSeq: 18 }), {
        key,
        authoritative: true,
        events: 4,
      }),
    Error,
    "below last acceptedCommitSeq",
  );
});

Deno.test("routing phase failures use fabric-safe snapshot diagnostics", () => {
  const withFabricDebugValue = {
    ...diagnostics({ executionAppliedSeq: 18 }),
    debugBigInt: 7n,
  } as ExecutionRoutingDiagnostics;

  assertThrows(
    () =>
      assertExactRoutingPhase(withFabricDebugValue, {
        key,
        authoritative: true,
        events: 4,
      }),
    Error,
    '"debugBigInt":7n',
  );
});

Deno.test("authoritative preflight requires a post-reset settlement", () => {
  assertAuthoritativePreflightSettlement(diagnostics(), key);

  assertThrows(
    () =>
      assertAuthoritativePreflightSettlement(
        diagnostics({
          actions: [action({
            settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
          })],
        }),
        key,
      ),
    Error,
    "post-reset committed/no-op settlement",
  );
});

Deno.test("preflight failures use fabric-safe snapshot diagnostics", () => {
  const withFabricDebugValue = {
    ...diagnostics({
      actions: [action({
        settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
      })],
    }),
    debugBigInt: 11n,
  } as ExecutionRoutingDiagnostics;

  assertThrows(
    () => assertAuthoritativePreflightSettlement(withFabricDebugValue, key),
    Error,
    '"debugBigInt":11n',
  );
});

Deno.test("authoritative preflight settlement must match the current incarnation", () => {
  const nextClaim: ExecutionClaim = {
    ...claim,
    claimGeneration: claim.claimGeneration + 1,
  };
  assertThrows(
    () =>
      assertAuthoritativePreflightSettlement(
        diagnostics({
          claims: [nextClaim],
          actions: [action({ liveClaim: nextClaim })],
        }),
        key,
      ),
    Error,
    "last settlement claim incarnation",
  );
});

Deno.test("authoritative routing phase requires exact settled claimed-overlay counts", () => {
  assertExactRoutingPhase(diagnostics(), {
    key,
    authoritative: true,
    events: 4,
  });

  assertThrows(
    () =>
      assertExactRoutingPhase(
        diagnostics({
          actions: [action({ pendingSettlementCount: 1 })],
        }),
        {
          key,
          authoritative: true,
          events: 4,
        },
      ),
    Error,
    "pendingSettlementCount",
  );
});

Deno.test("authoritative routing phase accepts one coalesced settlement covering all overlays", () => {
  assertExactRoutingPhase(
    diagnostics({
      actions: [action({
        settlements: { committed: 1, noOp: 0, failed: 0, unserved: 0 },
      })],
    }),
    {
      key,
      authoritative: true,
      events: 4,
    },
  );

  for (const committed of [0, 5]) {
    assertThrows(
      () =>
        assertExactRoutingPhase(
          diagnostics({
            actions: [action({
              settlements: { committed, noOp: 0, failed: 0, unserved: 0 },
            })],
          }),
          {
            key,
            authoritative: true,
            events: 4,
          },
        ),
      Error,
      "expected between 1 and 4",
    );
  }
});

Deno.test("authoritative routing counter reset accepts zero events and settlements", () => {
  assertExactRoutingPhase(
    diagnostics({
      actions: [action({
        claimedOverlayRoutes: 0,
        settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
        basisCoveredOverlayDrops: 0,
        lastSettlement: undefined,
      })],
    }),
    {
      key,
      authoritative: true,
      events: 0,
    },
  );
});

Deno.test("non-authoritative routing requires exact upstream-only counts", () => {
  const nonAuthoritative = diagnostics({
    claims: [],
    actions: [action({
      liveClaim: undefined,
      lastSettlement: undefined,
      upstreamRoutes: 4,
      claimedOverlayRoutes: 0,
      settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
      basisCoveredOverlayDrops: 0,
    })],
  });
  assertExactRoutingPhase(nonAuthoritative, {
    key,
    authoritative: false,
    events: 4,
  });

  assertThrows(
    () =>
      assertExactRoutingPhase({
        ...nonAuthoritative,
        actions: [action({
          liveClaim: undefined,
          lastSettlement: undefined,
          upstreamRoutes: 3,
          claimedOverlayRoutes: 1,
          settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
          basisCoveredOverlayDrops: 0,
        })],
      }, {
        key,
        authoritative: false,
        events: 4,
      }),
    Error,
    "upstreamRoutes",
  );
});

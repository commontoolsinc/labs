import { assertEquals } from "@std/assert";
import {
  isRoutingMeasurementBaselineReady,
  isRoutingMeasurementResultReady,
  type RoutingMeasurementAction,
  type RoutingMeasurementDiagnostics,
  routingMeasurementProblemActions,
} from "./server-execution-measurement-helpers.ts";

const SPACE = "did:key:z6Mk-measurement" as const;

const key = {
  space: SPACE,
  branch: "",
  contextKey: "space",
  pieceId: "of:piece",
  actionId: "action:computed",
  actionKind: "computation",
  implementationFingerprint: "implementation:test",
  runtimeFingerprint: "runtime:test",
};

const claim = {
  ...key,
  leaseGeneration: 1,
  claimGeneration: 2,
  expiresAt: 10_000,
};

const action = (
  overrides: Partial<RoutingMeasurementAction> = {},
): RoutingMeasurementAction => ({
  key,
  liveClaim: claim,
  claimedOverlayRoutes: 0,
  settlements: { committed: 0, noOp: 0, failed: 0, unserved: 0 },
  basisCoveredOverlayDrops: 0,
  nonAuthoritativeOverlayDrops: 0,
  pendingOverlayCount: 0,
  unresolvedBasisOverlayCount: 0,
  pendingSettlementCount: 0,
  ...overrides,
});

const diagnostics = (
  actions: readonly RoutingMeasurementAction[],
): RoutingMeasurementDiagnostics => ({
  snapshotRequired: false,
  claims: [claim],
  actions,
  branchTotals: {
    claimedOverlayRoutes: actions.reduce(
      (sum, action) => sum + action.claimedOverlayRoutes,
      0,
    ),
    settlements: actions.reduce(
      (totals, action) => ({
        committed: totals.committed + action.settlements.committed,
        noOp: totals.noOp + action.settlements.noOp,
        failed: totals.failed + action.settlements.failed,
        unserved: totals.unserved + action.settlements.unserved,
      }),
      { committed: 0, noOp: 0, failed: 0, unserved: 0 },
    ),
  },
  truncatedActionRecords: 0,
});

Deno.test("measurement baseline waits for every pre-existing overlay and settlement", () => {
  assertEquals(
    isRoutingMeasurementBaselineReady(diagnostics([action()])),
    true,
  );
  assertEquals(
    isRoutingMeasurementBaselineReady(diagnostics([
      action({ pendingOverlayCount: 1 }),
    ])),
    false,
  );
  assertEquals(
    isRoutingMeasurementBaselineReady(diagnostics([
      action({ unresolvedBasisOverlayCount: 1 }),
    ])),
    false,
  );
  assertEquals(
    isRoutingMeasurementBaselineReady(diagnostics([
      action({ pendingSettlementCount: 1 }),
    ])),
    false,
  );
});

Deno.test("measurement completion accepts a settled mix of served and unserved actions", () => {
  const served = action({
    claimedOverlayRoutes: 2,
    settlements: { committed: 1, noOp: 0, failed: 0, unserved: 0 },
    basisCoveredOverlayDrops: 2,
  });
  const unserved = action({
    key: { ...key, actionId: "action:fallback" },
    liveClaim: undefined,
    claimedOverlayRoutes: 1,
    settlements: { committed: 0, noOp: 0, failed: 0, unserved: 1 },
    lastSettlement: {
      outcome: "unserved",
      diagnosticCode: "dynamic-read-outside-static-surface",
    },
  });

  assertEquals(
    isRoutingMeasurementResultReady(diagnostics([served, unserved])),
    true,
  );
  assertEquals(
    isRoutingMeasurementResultReady({
      ...diagnostics([served, unserved]),
      truncatedActionRecords: 200,
    }),
    true,
  );
  assertEquals(
    isRoutingMeasurementResultReady(diagnostics([
      served,
      { ...unserved, pendingOverlayCount: 1 },
    ])),
    false,
  );
});

Deno.test("measurement diagnostics retain bounded action identity and fallback reason", () => {
  const fallbackClaim = { ...claim, actionId: "action:fallback" };
  const problems = routingMeasurementProblemActions(diagnostics([
    action({
      key: { ...key, actionId: fallbackClaim.actionId },
      liveClaim: undefined,
      claimedOverlayRoutes: 1,
      settlements: { committed: 0, noOp: 0, failed: 0, unserved: 1 },
      lastSettlement: {
        outcome: "unserved",
        diagnosticCode: "dynamic-read-outside-static-surface",
      },
    }),
  ]));

  assertEquals(problems, [{
    actionId: "action:fallback",
    pieceId: key.pieceId,
    liveClaim: false,
    claimedOverlayRoutes: 1,
    settlements: { committed: 0, noOp: 0, failed: 0, unserved: 1 },
    basisCoveredOverlayDrops: 0,
    nonAuthoritativeOverlayDrops: 0,
    pendingOverlayCount: 0,
    unresolvedBasisOverlayCount: 0,
    pendingSettlementCount: 0,
    lastSettlement: {
      outcome: "unserved",
      diagnosticCode: "dynamic-read-outside-static-surface",
    },
  }]);
});

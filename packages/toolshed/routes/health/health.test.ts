import { assertEquals } from "@std/assert";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import {
  setServerExecutionControlMetricsProvider,
  setServerExecutionFeedMetricsProvider,
  setServerExecutionPoolMetricsProvider,
} from "@/lib/server-execution-observability.ts";
import router from "@/routes/health/health.index.ts";
import { HealthStatsResponseSchema } from "@/routes/health/health.routes.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

const poolMetrics = {
  activeLanes: 1,
  activeWorkers: 1,
  activeDemands: 2,
  states: {
    waiting: 0,
    excluded: 0,
    starting: 0,
    live: 1,
    draining: 0,
    backoff: 0,
  },
  demandSnapshots: 3,
  executionPlacement: {
    schedulerRuns: 7,
    asyncRequests: 2,
    actionTransactions: { shadow: 5, authoritative: 2 },
  },
  workerStartAttempts: 1,
  workerStartAborts: 0,
  workerStartFailures: 0,
  workersStarted: 1,
  workersStopped: 0,
  abruptStops: 0,
  leaseLosses: 0,
  leaseReplacements: 0,
  sponsorRotations: 0,
  crashes: 0,
  acceptedCommitNotifications: 5,
  acceptedCommitIndexDecisions: 4,
  suppressedUnrelatedCommits: 2,
  parkedWakeAttempts: 1,
  parkedWakeStarts: 1,
  demandEmptyHibernations: 0,
  userLanesOpened: 0,
  userLanesClosed: 0,
  userLaneReanchors: 0,
  activeUserLanes: 0,
};

const controlMetrics = {
  claimsIssued: 2,
  claimsReissued: 1,
  claimsRevoked: 1,
  claimsIssuedByContextKey: { space: 2 },
  acceptedActionAttempts: 4,
  claimedActionConflicts: 1,
  settlementsPublished: 4,
  settlementsCommitted: 2,
  settlementsNoOp: 1,
  settlementsFailed: 1,
  settlementsUnserved: 0,
  leaseFenceRejects: 0,
  leaseFenceRejectCauses: {},
  actionFirewallRejects: 0,
  acceptedCommitIndexLookups: 5,
  acceptedCommitIndexTargetCandidates: 8,
  acceptedCommitIndexDemandedPieces: 2,
  acceptedCommitIndexMatches: 4,
  candidateClaimReadyBySpace: { "did:key:z6Mk-space": 3 },
  candidateUnservedBySpace: { "did:key:z6Mk-space": 4 },
  candidateUnservedByCode: { "static-read-outside-space": 4 },
  candidateUnservedOffendersByCode: { "static-read-outside-space": 1 },
};

const feedMetrics = {
  refreshWaves: 6,
  refreshSessionsTouched: 4,
  refreshGraphsRefreshed: 3,
  refreshUpsertsPushed: 9,
  docSetMemberDeliveries: 7,
  docSetMembersTracked: 5,
  refreshRetirementEligibleSessions: 2,
  refreshFullyDocSetSessions: 1,
  refreshResidualGraphWatches: 1,
  refreshResidualGraphWatchesTraversed: 1,
  refreshResidualDagTraversalsBySpace: { "did:key:z6Mk-space": 4 },
  traversalByOperation: {
    "session.watch.refresh": {
      calls: 3,
      managerReads: 12,
      coveredSelectorSkips: 1,
      schemaTraversals: 8,
      pointerTraversals: 2,
      arrayTraversals: 1,
      objectTraversals: 5,
      dagTraversals: 8,
      getDocAtPathCalls: 2,
      schemaMemoHits: 4,
    },
    "graph.query": {
      calls: 2,
      managerReads: 6,
      coveredSelectorSkips: 0,
      schemaTraversals: 4,
      pointerTraversals: 1,
      arrayTraversals: 0,
      objectTraversals: 2,
      dagTraversals: 4,
      getDocAtPathCalls: 1,
      schemaMemoHits: 0,
    },
    // FW6 (FA5/FB12): the wave-vs-demand sub-buckets of graph.query ride the
    // same open record — additive keys, no schema change.
    "graph.query.wave": {
      calls: 1,
      managerReads: 3,
      coveredSelectorSkips: 0,
      schemaTraversals: 2,
      pointerTraversals: 1,
      arrayTraversals: 0,
      objectTraversals: 1,
      dagTraversals: 2,
      getDocAtPathCalls: 1,
      schemaMemoHits: 0,
    },
    "graph.query.demand": {
      calls: 1,
      managerReads: 3,
      coveredSelectorSkips: 0,
      schemaTraversals: 2,
      pointerTraversals: 0,
      arrayTraversals: 0,
      objectTraversals: 1,
      dagTraversals: 2,
      getDocAtPathCalls: 0,
      schemaMemoHits: 0,
    },
  },
};

Deno.test("health routes", async (t) => {
  await t.step("GET /_health returns 200 with health status", async () => {
    const response = await app.request("/_health");
    assertEquals(response.status, 200);

    const json = await response.json();
    assertEquals(json.status, "OK");
    assertEquals(typeof json.timestamp, "number");
  });

  await t.step(
    "GET /api/health/stats exposes server execution pool metrics",
    async () => {
      const response = await app.request("/api/health/stats");
      assertEquals(response.status, 200);

      const json = await response.json();
      assertEquals("serverExecutionPool" in json, true);
      assertEquals(json.serverExecutionPool, null);
      assertEquals("serverExecutionControl" in json, true);
      assertEquals(json.serverExecutionControl, null);
      assertEquals("serverExecutionFeed" in json, true);
      assertEquals(json.serverExecutionFeed, null);
    },
  );

  await t.step(
    "GET /api/health/stats exposes bounded non-null execution metrics",
    async () => {
      setServerExecutionPoolMetricsProvider(() => poolMetrics);
      setServerExecutionControlMetricsProvider(() => controlMetrics);
      setServerExecutionFeedMetricsProvider(() => feedMetrics);
      try {
        const response = await app.request("/api/health/stats");
        assertEquals(response.status, 200);
        const json = await response.json();
        assertEquals(json.serverExecutionPool, poolMetrics);
        assertEquals(json.serverExecutionControl, controlMetrics);
        assertEquals(json.serverExecutionFeed, feedMetrics);
      } finally {
        setServerExecutionPoolMetricsProvider(() => null);
        setServerExecutionControlMetricsProvider(() => null);
        setServerExecutionFeedMetricsProvider(() => null);
      }
    },
  );

  await t.step(
    "execution health schemas reject unknown metric keys",
    () => {
      const response = {
        timestamp: 1,
        serverStart: 1,
        logCounts: {},
        timingStats: {},
        slowQueries: [],
        serverExecutionPool: poolMetrics,
        serverExecutionControl: controlMetrics,
        serverExecutionFeed: feedMetrics,
      };
      assertEquals(HealthStatsResponseSchema.safeParse(response).success, true);
      assertEquals(
        HealthStatsResponseSchema.safeParse({
          ...response,
          serverExecutionPool: { ...poolMetrics, space: "unbounded" },
        }).success,
        false,
      );
      assertEquals(
        HealthStatsResponseSchema.safeParse({
          ...response,
          serverExecutionControl: { ...controlMetrics, outcome: 1 },
        }).success,
        false,
      );
      assertEquals(
        HealthStatsResponseSchema.safeParse({
          ...response,
          serverExecutionFeed: { ...feedMetrics, elapsedMs: 1 },
        }).success,
        false,
      );
      // Traversal buckets are keyed by operation but each bucket is bounded.
      assertEquals(
        HealthStatsResponseSchema.safeParse({
          ...response,
          serverExecutionFeed: {
            ...feedMetrics,
            traversalByOperation: {
              "graph.query": {
                ...feedMetrics.traversalByOperation["graph.query"],
                timing: 3,
              },
            },
          },
        }).success,
        false,
      );
    },
  );
});

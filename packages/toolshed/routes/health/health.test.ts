import { assertEquals } from "@std/assert";

import env from "@/env.ts";
import createApp from "@/lib/create-app.ts";
import {
  setServerExecutionControlMetricsProvider,
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
};

const controlMetrics = {
  policyInactiveClaimAttempts: 0,
  claimsIssued: 2,
  claimsReissued: 1,
  claimsRevoked: 1,
  acceptedActionAttempts: 4,
  claimedActionConflicts: 1,
  settlementsPublished: 4,
  settlementsCommitted: 2,
  settlementsNoOp: 1,
  settlementsFailed: 1,
  settlementsUnserved: 0,
  leaseFenceRejects: 0,
  actionFirewallRejects: 0,
  acceptedCommitIndexLookups: 5,
  acceptedCommitIndexTargets: 8,
  acceptedCommitIndexDemandedPieces: 2,
  acceptedCommitIndexMatches: 4,
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
    },
  );

  await t.step(
    "GET /api/health/stats exposes bounded non-null execution metrics",
    async () => {
      setServerExecutionPoolMetricsProvider(() => poolMetrics);
      setServerExecutionControlMetricsProvider(() => controlMetrics);
      try {
        const response = await app.request("/api/health/stats");
        assertEquals(response.status, 200);
        const json = await response.json();
        assertEquals(json.serverExecutionPool, poolMetrics);
        assertEquals(json.serverExecutionControl, controlMetrics);
      } finally {
        setServerExecutionPoolMetricsProvider(() => null);
        setServerExecutionControlMetricsProvider(() => null);
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
    },
  );
});

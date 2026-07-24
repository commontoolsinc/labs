import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { z } from "zod";
import {
  HealthResponseSchema,
  LLMHealthResponseSchema,
} from "./health.handlers.ts";

const tags = ["Health"];

const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const ServerExecutionPoolMetricsSchema = z.object({
  activeLanes: nonNegativeIntegerSchema,
  activeWorkers: nonNegativeIntegerSchema,
  activeDemands: nonNegativeIntegerSchema,
  states: z.object({
    waiting: nonNegativeIntegerSchema,
    excluded: nonNegativeIntegerSchema,
    starting: nonNegativeIntegerSchema,
    live: nonNegativeIntegerSchema,
    draining: nonNegativeIntegerSchema,
    backoff: nonNegativeIntegerSchema,
  }).strict(),
  demandSnapshots: nonNegativeIntegerSchema,
  executionPlacement: z.object({
    schedulerRuns: nonNegativeIntegerSchema,
    asyncRequests: nonNegativeIntegerSchema,
    actionTransactions: z.object({
      shadow: nonNegativeIntegerSchema,
      authoritative: nonNegativeIntegerSchema,
    }).strict(),
  }).strict(),
  workerStartAttempts: nonNegativeIntegerSchema,
  workerStartAborts: nonNegativeIntegerSchema,
  workerStartFailures: nonNegativeIntegerSchema,
  workersStarted: nonNegativeIntegerSchema,
  workersStopped: nonNegativeIntegerSchema,
  abruptStops: nonNegativeIntegerSchema,
  leaseLosses: nonNegativeIntegerSchema,
  leaseReplacements: nonNegativeIntegerSchema,
  sponsorRotations: nonNegativeIntegerSchema,
  crashes: nonNegativeIntegerSchema,
  acceptedCommitNotifications: nonNegativeIntegerSchema,
  acceptedCommitIndexDecisions: nonNegativeIntegerSchema,
  suppressedUnrelatedCommits: nonNegativeIntegerSchema,
  parkedWakeAttempts: nonNegativeIntegerSchema,
  parkedWakeStarts: nonNegativeIntegerSchema,
  // C3.3a shared-pool foreign-wake counters (the C3A11 gate-bypass entry).
  foreignWakeNotifications: nonNegativeIntegerSchema,
  foreignWakeAttempts: nonNegativeIntegerSchema,
  demandEmptyHibernations: nonNegativeIntegerSchema,
  // C1 shared-pool user-lane gauges (intra-Worker lane identity).
  userLanesOpened: nonNegativeIntegerSchema,
  userLanesClosed: nonNegativeIntegerSchema,
  userLaneReanchors: nonNegativeIntegerSchema,
  activeUserLanes: nonNegativeIntegerSchema,
  // C2.7 shared-pool session-lane gauges (session-end = lane-end).
  sessionLanesOpened: nonNegativeIntegerSchema,
  sessionLanesClosed: nonNegativeIntegerSchema,
  sessionLaneReopens: nonNegativeIntegerSchema,
  activeSessionLanes: nonNegativeIntegerSchema,
}).strict();

export const ServerExecutionControlMetricsSchema = z.object({
  claimsIssued: nonNegativeIntegerSchema,
  claimsReissued: nonNegativeIntegerSchema,
  claimsRevoked: nonNegativeIntegerSchema,
  claimsIssuedByContextKey: z.record(z.string(), nonNegativeIntegerSchema),
  acceptedActionAttempts: nonNegativeIntegerSchema,
  claimedActionConflicts: nonNegativeIntegerSchema,
  settlementsPublished: nonNegativeIntegerSchema,
  settlementsCommitted: nonNegativeIntegerSchema,
  settlementsNoOp: nonNegativeIntegerSchema,
  settlementsFailed: nonNegativeIntegerSchema,
  settlementsUnserved: nonNegativeIntegerSchema,
  leaseFenceRejects: nonNegativeIntegerSchema,
  leaseFenceRejectCauses: z.record(z.string(), nonNegativeIntegerSchema),
  actionFirewallRejects: nonNegativeIntegerSchema,
  // C3.3b/C3.5 cross-space counters: withheld mirrors, stripped
  // Worker-asserted basis stamps, and host-validated basis components.
  crossSpaceMirrorsWithheld: nonNegativeIntegerSchema,
  foreignBasisAssertionsStripped: nonNegativeIntegerSchema,
  foreignBasisComponentsValidated: nonNegativeIntegerSchema,
  acceptedCommitIndexLookups: nonNegativeIntegerSchema,
  acceptedCommitIndexTargetCandidates: nonNegativeIntegerSchema,
  acceptedCommitIndexDemandedPieces: nonNegativeIntegerSchema,
  acceptedCommitIndexMatches: nonNegativeIntegerSchema,
  // F1 claim-coverage counters: candidate outcomes per space and diagnostic
  // code (the console.debug grep replacement; OQ4 rollout-gate input).
  candidateClaimReadyBySpace: z.record(z.string(), nonNegativeIntegerSchema),
  candidateUnservedBySpace: z.record(z.string(), nonNegativeIntegerSchema),
  candidateUnservedByCode: z.record(z.string(), nonNegativeIntegerSchema),
  candidateUnservedOffendersByCode: z.record(
    z.string(),
    nonNegativeIntegerSchema,
  ),
}).strict();

// F1 feed observability: per-wave delivery counters plus traversal work
// summed per memory-server operation ("session.watch.refresh" vs the
// executor-driven "graph.query", plus watch registration operations).
export const ServerExecutionFeedMetricsSchema = z.object({
  refreshWaves: nonNegativeIntegerSchema,
  refreshSessionsTouched: nonNegativeIntegerSchema,
  refreshGraphsRefreshed: nonNegativeIntegerSchema,
  refreshUpsertsPushed: nonNegativeIntegerSchema,
  // F3 doc-set membership fan-out gauges.
  docSetMemberDeliveries: nonNegativeIntegerSchema,
  docSetMembersTracked: nonNegativeIntegerSchema,
  // F5/FA13 graph-refresh retirement gauges (per-wave aggregates). The
  // residual pair splits surface composition (watches HELD, per watch) from
  // actual work (watches whose branch group re-traversed — FB28); the
  // per-space record is the FB11 mixed-mode residual-traversal budget input.
  refreshRetirementEligibleSessions: nonNegativeIntegerSchema,
  refreshFullyDocSetSessions: nonNegativeIntegerSchema,
  refreshResidualGraphWatches: nonNegativeIntegerSchema,
  refreshResidualGraphWatchesTraversed: nonNegativeIntegerSchema,
  refreshResidualDagTraversalsBySpace: z.record(
    z.string(),
    nonNegativeIntegerSchema,
  ),
  traversalByOperation: z.record(
    z.string(),
    z.object({
      calls: nonNegativeIntegerSchema,
      managerReads: nonNegativeIntegerSchema,
      coveredSelectorSkips: nonNegativeIntegerSchema,
      schemaTraversals: nonNegativeIntegerSchema,
      pointerTraversals: nonNegativeIntegerSchema,
      arrayTraversals: nonNegativeIntegerSchema,
      objectTraversals: nonNegativeIntegerSchema,
      dagTraversals: nonNegativeIntegerSchema,
      getDocAtPathCalls: nonNegativeIntegerSchema,
      schemaMemoHits: nonNegativeIntegerSchema,
    }).strict(),
  ),
}).strict();

export const HealthStatsResponseSchema = z.object({
  timestamp: z.number(),
  serverStart: z.number(),
  logCounts: z.any(),
  timingStats: z.any(),
  slowQueries: z.array(z.any()),
  serverExecutionPool: ServerExecutionPoolMetricsSchema.nullable(),
  serverExecutionControl: ServerExecutionControlMetricsSchema.nullable(),
  serverExecutionFeed: ServerExecutionFeedMetricsSchema.nullable(),
}).strict();

export const index = createRoute({
  path: "/_health",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      HealthResponseSchema,
      "The health status",
    ),
  },
});

export const stats = createRoute({
  path: "/api/health/stats",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      HealthStatsResponseSchema,
      "Logger counts and timing statistics",
    ),
  },
});

export const dash = createRoute({
  path: "/api/health/dash",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "text/html": {
          schema: z.any().describe("Health dashboard HTML page"),
        },
      },
      description: "Health dashboard",
    },
  },
});

export const llm = createRoute({
  path: "/api/health/llm",
  method: "get",
  tags,
  query: z.object({
    verbose: z.string().optional(),
    alert: z.string().optional(),
    models: z.string().optional(),
    forceAlert: z.string().optional(),
  }),
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      LLMHealthResponseSchema,
      "LLM health check status",
    ),
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
      LLMHealthResponseSchema,
      "LLM services are unhealthy",
    ),
  },
});

export type IndexRoute = typeof index;
export type StatsRoute = typeof stats;
export type DashRoute = typeof dash;
export type LLMRoute = typeof llm;

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
  demandEmptyHibernations: nonNegativeIntegerSchema,
}).strict();

export const ServerExecutionControlMetricsSchema = z.object({
  policyInactiveClaimAttempts: nonNegativeIntegerSchema,
  claimsIssued: nonNegativeIntegerSchema,
  claimsReissued: nonNegativeIntegerSchema,
  claimsRevoked: nonNegativeIntegerSchema,
  acceptedActionAttempts: nonNegativeIntegerSchema,
  claimedActionConflicts: nonNegativeIntegerSchema,
  settlementsPublished: nonNegativeIntegerSchema,
  settlementsCommitted: nonNegativeIntegerSchema,
  settlementsNoOp: nonNegativeIntegerSchema,
  settlementsFailed: nonNegativeIntegerSchema,
  settlementsUnserved: nonNegativeIntegerSchema,
  leaseFenceRejects: nonNegativeIntegerSchema,
  actionFirewallRejects: nonNegativeIntegerSchema,
}).strict();

export const HealthStatsResponseSchema = z.object({
  timestamp: z.number(),
  serverStart: z.number(),
  logCounts: z.any(),
  timingStats: z.any(),
  slowQueries: z.array(z.any()),
  serverExecutionPool: ServerExecutionPoolMetricsSchema.nullable(),
  serverExecutionControl: ServerExecutionControlMetricsSchema.nullable(),
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

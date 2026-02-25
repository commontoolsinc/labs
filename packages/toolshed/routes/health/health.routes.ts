import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { z } from "zod";
import {
  HealthResponseSchema,
  LLMHealthResponseSchema,
} from "./health.handlers.ts";

const tags = ["Health"];

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
      z.object({
        timestamp: z.number(),
        logCounts: z.any(),
        timingStats: z.any(),
      }),
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

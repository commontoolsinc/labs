import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute, LLMRoute } from "./health.routes.ts";
import { checkLLMHealth } from "./llm-health.service.ts";

export const HealthResponseSchema = z.object({
  status: z.literal("OK"),
  timestamp: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const LLMHealthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  timestamp: z.number(),
  summary: z.object({
    total: z.number(),
    healthy: z.number(),
    failed: z.number(),
  }),
  models: z.record(z.object({
    status: z.enum(["healthy", "failed"]),
    latencyMs: z.number().nullable(),
    error: z.string().optional(),
  })),
  alertSent: z.boolean(),
});
export type LLMHealthResponse = z.infer<typeof LLMHealthResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: HealthResponse = {
    status: "OK",
    timestamp: Date.now(),
  };
  return c.json(response, HttpStatusCodes.OK);
};

export const llm: AppRouteHandler<LLMRoute> = async (c) => {
  const { verbose, alert, models: modelFilter, forceAlert } = c.req.query();

  // Call the service to perform the health check
  const result = await checkLLMHealth({
    modelFilter,
    isVerbose: verbose === "true",
    shouldAlert: alert === "true",
    shouldForceAlert: forceAlert === "true",
  });

  // Return appropriate status code based on health status
  const statusCode = result.status === "unhealthy"
    ? HttpStatusCodes.SERVICE_UNAVAILABLE
    : HttpStatusCodes.OK;

  return c.json(result, statusCode);
};

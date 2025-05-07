import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { IndexRoute } from "./health.routes.ts";

export const HealthResponseSchema = z.object({
  status: z.literal("OK"),
  timestamp: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const index: AppRouteHandler<IndexRoute> = (c) => {
  const response: HealthResponse = {
    status: "OK",
    timestamp: Date.now(),
  };
  return c.json(response, HttpStatusCodes.OK);
};

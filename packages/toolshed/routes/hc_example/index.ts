import { createRoute } from "@hono/zod-openapi";
import { hc } from "@hono/hono/client";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

import { createRouter } from "@/lib/create-app.ts";
import {
  HealthNotReadyResponseSchema,
  HealthResponseSchema,
} from "@/routes/health/health.handlers.ts";
import { type AppType } from "@/app.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import env from "@/env.ts";
const tags = ["Health RPC Client"];

export const index = createRoute({
  path: "/hc-example",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      HealthResponseSchema,
      "The health status",
    ),
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
      HealthNotReadyResponseSchema,
      "Service not ready",
    ),
  },
});

export const indexHandler: AppRouteHandler<typeof index> = async (c) => {
  // NOTE(jake): This is an example illustration of how to perform Hono RPC
  // calls to endpoints within the application.

  // Create a client that points to the server. The URL would change for production.
  const client = hc<AppType>(env.API_URL);

  // Call the health endpoint.
  const res = await client._health.$get();

  // Parse the response as JSON.
  const data = await res.json();

  // Return with the same status code as the upstream response
  if (res.status === HttpStatusCodes.SERVICE_UNAVAILABLE) {
    return c.json(
      data as { status: "NOT_READY"; reason: string },
      HttpStatusCodes.SERVICE_UNAVAILABLE,
    );
  }

  // Return the parsed data.
  return c.json(
    data as { status: "OK"; timestamp: number },
    HttpStatusCodes.OK,
  );
};

const router = createRouter()
  .openapi(index, indexHandler);

export default router;

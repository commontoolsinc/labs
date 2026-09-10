import type { Context } from "@hono/hono";
import { createPatternsRoute } from "./patterns-server.ts";

// Create a single route instance to be reused across requests: it memoizes
// each pattern's closure identity, which is fixed for the process's lifetime.
const patternsRoute = createPatternsRoute();

/**
 * Handler for serving pattern files from the patterns directory. The router
 * has already split the path, so the file is asked for by name; everything
 * else about the answer — validation, `?identity`, ETags, status mapping —
 * belongs to the route.
 */
export const getPattern = (c: Context): Promise<Response> => {
  const { filename } = c.req.param();
  return patternsRoute.serveFile(filename, {
    identity: new URL(c.req.url).searchParams.has("identity"),
    ifNoneMatch: c.req.header("If-None-Match"),
  });
};

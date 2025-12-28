import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";

import * as handlers from "./patterns.handlers.ts";
import * as routes from "./patterns.routes.ts";
import * as compiledHandlers from "./compiled.handlers.ts";
import * as compiledRoutes from "./compiled.routes.ts";

const router = createRouter();

// Apply CORS middleware to all patterns routes
router.use(
  "/api/patterns/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// Compiled patterns endpoint (must be registered before raw patterns to take precedence)
router.openapi(compiledRoutes.getCompiledPattern, compiledHandlers.getCompiledPattern);

// Raw pattern source endpoint
router.openapi(routes.getPattern, handlers.getPattern);

export default router;

import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";

import * as handlers from "./collab.handlers.ts";
import * as routes from "./collab.routes.ts";

const router = createRouter();

/**
 * Collaboration Routes for Real-time Editing
 *
 * SECURITY NOTE: These endpoints are currently unauthenticated.
 * Room IDs are typically Cell entity IDs, providing implicit access control
 * through obscurity (clients need to know the entity ID to connect).
 *
 * TODO: For production, implement proper authentication:
 * - For the init endpoint: Verify Authorization header with UCAN or bearer token
 * - For WebSocket: Use Sec-WebSocket-Protocol to pass auth tokens
 *   (or include token in the URL as a query param)
 * - Consider rate limiting per IP/user
 * - Consider room-level access control based on Cell permissions
 */

// Enable CORS for the collab endpoints
router.use(
  "/api/collab/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Upgrade", "Connection"],
  }),
);

// Register routes
// Note: stats route must come before the :roomId route to avoid matching "stats" as roomId
const Router = router
  .openapi(routes.stats, handlers.stats)
  .openapi(routes.initialize, handlers.initialize)
  .openapi(routes.websocket, handlers.websocket);

export default Router;

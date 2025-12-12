import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";

import * as handlers from "./collab.handlers.ts";
import * as routes from "./collab.routes.ts";

const router = createRouter();

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

import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./web-search.handlers.ts";
import * as routes from "./web-search.routes.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter();

router.use(
  "/api/agent-tools/web-search/*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

router.openapi(routes.webSearch, handlers.webSearch);

export default router;

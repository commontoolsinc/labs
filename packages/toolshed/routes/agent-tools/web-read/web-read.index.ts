import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./web-read.handlers.ts";
import * as routes from "./web-read.routes.ts";
import { cors } from "@hono/hono/cors";
const router = createRouter()
  .openapi(routes.readWebPage, handlers.readWebPage)
  .openapi(routes.readWebPageAdvanced, handlers.readWebPageAdvanced);

router.use(
  "/api/agent-tools/web-read/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

export default router;

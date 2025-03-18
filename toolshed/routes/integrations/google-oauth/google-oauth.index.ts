import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./google-oauth.handlers.ts";
import * as routes from "./google-oauth.routes.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter()
  .openapi(routes.login, handlers.login)
  .openapi(routes.callback, handlers.callback)
  .openapi(routes.refresh, handlers.refresh)
  .openapi(routes.logout, handlers.logout)
  .openapi(routes.backgroundIntegration, handlers.backgroundIntegration);

router.use(
  "/api/integrations/google-oauth/*",
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

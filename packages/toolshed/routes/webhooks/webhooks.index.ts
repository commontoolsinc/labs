import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./webhooks.handlers.ts";
import * as routes from "./webhooks.routes.ts";
import { cors } from "@hono/hono/cors";
import { bodyLimit } from "@hono/hono/body-limit";

const router = createRouter();

router.use(
  "/api/webhooks/*",
  bodyLimit({
    maxSize: 1_000_000,
    onError: (c) => c.json({ error: "Payload too large (max 1MB)" }, 413),
  }),
);

router.use(
  "/api/webhooks/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    maxAge: 3600,
    credentials: true,
  }),
);

export default router
  .openapi(routes.create, handlers.create)
  .openapi(routes.ingest, handlers.ingest)
  .openapi(routes.list, handlers.list)
  .openapi(routes.remove, handlers.remove);

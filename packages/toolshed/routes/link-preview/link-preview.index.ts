import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./link-preview.handlers.ts";
import * as routes from "./link-preview.routes.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter()
  .openapi(routes.getLinkPreview, handlers.getLinkPreview);

router.use(
  "/api/link-preview/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

export default router;

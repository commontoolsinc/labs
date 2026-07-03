import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./ingest.handlers.ts";
import * as routes from "./ingest.routes.ts";
import { cors } from "@hono/hono/cors";
import { bodyLimit } from "@hono/hono/body-limit";

const router = createRouter();

router.use(
  "/api/ingest/*",
  bodyLimit({
    maxSize: 1_000_000,
    onError: (c) => c.json({ error: "Payload too large (max 1MB)" }, 413),
  }),
);

router.use(
  "/api/ingest/*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    maxAge: 3600,
  }),
);

export default router.openapi(routes.ingest, handlers.ingest);

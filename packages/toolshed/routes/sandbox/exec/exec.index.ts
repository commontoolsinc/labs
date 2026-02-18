import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./exec.handlers.ts";
import * as routes from "./exec.routes.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter();

router.use(
  "/api/sandbox/exec/*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 3600,
  }),
);

router.openapi(routes.sandboxExec, handlers.sandboxExec);

export default router;

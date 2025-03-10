import { createRouter } from "@/lib/create-app.ts";
import * as handlers from "./whoami.handlers.ts";
import * as routes from "./whoami.routes.ts";
import { cors } from "@hono/hono/cors";

const router = createRouter();

router.use(
  "/api/whoami",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

const Router = router.openapi(routes.whoami, handlers.whoamiHandler);

export default Router;

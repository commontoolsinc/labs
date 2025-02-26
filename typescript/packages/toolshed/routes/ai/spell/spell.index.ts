// NOTE(jake): The redis client is javascript, and so the types are weird.
// To get things working, we need to include this special reference thing.
/// <reference types="npm:@types/node" />

import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import * as handlers from "./spell.handlers.ts";
import * as routes from "./spell.routes.ts";

const router = createRouter();

router.use(
  "/api/ai/spell/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Disk-Cache"],
    maxAge: 3600,
    credentials: true,
  }),
);

const Router = router
  .openapi(routes.recast, handlers.recast)
  .openapi(routes.reuse, handlers.reuse)
  .openapi(routes.fulfill, handlers.fulfill)
  .openapi(routes.spellSearch, handlers.spellSearch);

export default Router;

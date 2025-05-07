// NOTE(jake): The redis client is javascript, and so the types are weird.
// To get things working, we need to include this special reference thing.
/// <reference types="npm:@types/node" />

import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import * as routes from "./spell.routes.ts";
import { fulfill } from "./handlers/fulfill.ts";
import { imagine } from "./handlers/imagine.ts";
import { recast } from "./handlers/recast.ts";
import { reuse } from "./handlers/reuse.ts";
import { findSpellBySchema } from "./handlers/find-spell-by-schema.ts";

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
  .openapi(routes.recast, recast)
  .openapi(routes.reuse, reuse)
  .openapi(routes.imagine, imagine)
  .openapi(routes.findSpellBySchema, findSpellBySchema)
  .openapi(routes.fulfill, fulfill);

export default Router;

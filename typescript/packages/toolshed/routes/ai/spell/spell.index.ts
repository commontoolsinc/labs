// NOTE(jake): The redis client is javascript, and so the types are weird.
// To get things working, we need to include this special reference thing.
/// <reference types="npm:@types/node" />

import { createRouter } from "@/lib/create-app.ts";
import env from "@/env.ts";
import { createClient } from "redis";
import type { RedisClientType } from "redis";

import * as handlers from "./spell.handlers.ts";
import * as routes from "./spell.routes.ts";

const router = createRouter();

const Router = router
  .openapi(routes.fulfill, handlers.fulfill)
  .openapi(routes.search, handlers.search);

export default Router;

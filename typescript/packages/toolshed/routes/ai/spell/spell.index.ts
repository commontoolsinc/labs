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

router.use("*", async (c, next) => {
  const logger = c.get("logger");
  try {
    const redis = createClient({
      url: env.BLOBBY_REDIS_URL,
    });

    redis.on("error", (err) => {
      logger.error({ err }, "Redis client error");
    });

    logger.info("Connecting to Redis...");
    if (!redis.isOpen) {
      await redis.connect();
    }
    logger.info("Redis connected successfully");

    c.set("blobbyRedis", redis as RedisClientType);
    await next();
    logger.info("Closing Redis connection");
    await redis.quit();
  } catch (error) {
    logger.error({ error }, "Error in Redis middleware");
    throw error;
  }
});

router.openapi(routes.imagine, handlers.imagine);
router.openapi(routes.search, handlers.search);

export default router;

import { createClient, type RedisClientType } from "redis";
import env from "@/env.ts";
import { DiskStorage } from "@/routes/storage/blobby/lib/storage.ts";

const DATA_DIR = `${env.CACHE_DIR}/blobby`;

export const storage = new DiskStorage(DATA_DIR);
await storage.init();

let redisClient: RedisClientType | null = null;

export const getRedisClient = async () => {
  if (!redisClient) {
    redisClient = createClient({
      url: env.BLOBBY_REDIS_URL,
    });
  }
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  return redisClient;
};

export const closeRedisClient = async () => {
  if (redisClient?.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
};

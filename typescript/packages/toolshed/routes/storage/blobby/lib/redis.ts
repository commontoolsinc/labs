import { createClient } from "redis";
import { DiskStorage } from "./storage.ts";

const REDIS_PREFIX = "ct:toolshed:blobby";
const DATA_DIR = "./cache/blobby";

export type RedisClient = ReturnType<typeof createClient>;
export const storage = new DiskStorage(DATA_DIR);

await storage.init();

export async function addBlobToUser(
  redis: RedisClient,
  hash: string,
  user: string,
) {
  await Promise.all([
    redis.sAdd(`${REDIS_PREFIX}:user:${user}:blobs`, hash),
    redis.sAdd(`${REDIS_PREFIX}:blob:${hash}:users`, user),
    redis.sAdd(`${REDIS_PREFIX}:blobs`, hash),
  ]);
}

export async function getBlobUsers(
  redis: RedisClient,
  hash: string,
): Promise<string[]> {
  return await redis.sMembers(`${REDIS_PREFIX}:blob:${hash}:users`);
}

export async function getUserBlobs(
  redis: RedisClient,
  user: string,
): Promise<string[]> {
  return await redis.sMembers(`${REDIS_PREFIX}:user:${user}:blobs`);
}

export async function getAllBlobs(redis: RedisClient): Promise<string[]> {
  return await redis.sMembers(`${REDIS_PREFIX}:blobs`);
}

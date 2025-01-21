import { createClient } from "redis";

const REDIS_PREFIX = "ct:toolshed:blobby";

export type RedisClient = ReturnType<typeof createClient>;

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

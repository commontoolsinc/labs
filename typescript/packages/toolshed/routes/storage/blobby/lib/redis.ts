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

export async function removeBlobFromUser(
  redis: RedisClient,
  hash: string,
) {
  // Get all users associated with this blob
  const users = await getBlobUsers(redis, hash);

  // Remove the blob from all user sets and global sets
  await Promise.all([
    ...users.map((user) =>
      redis.sRem(`${REDIS_PREFIX}:user:${user}:blobs`, hash)
    ),
    redis.sRem(`${REDIS_PREFIX}:blobs`, hash),
    redis.del(`${REDIS_PREFIX}:blob:${hash}:users`),
  ]);
}

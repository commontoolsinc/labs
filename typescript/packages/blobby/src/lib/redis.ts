import {
  RedisClientType,
  type RedisFunctions,
  type RedisModules,
  type RedisScripts,
} from "redis";

const REDIS_PREFIX = "ct:blobby";

export type RedisClient = RedisClientType<
  RedisModules,
  RedisFunctions,
  RedisScripts
>;

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
  return redis.sMembers(`${REDIS_PREFIX}:blob:${hash}:users`);
}

export async function getUserBlobs(
  redis: RedisClient,
  user: string,
): Promise<string[]> {
  return redis.sMembers(`${REDIS_PREFIX}:user:${user}:blobs`);
}

export async function getAllBlobs(
  redis: RedisClient,
): Promise<string[]> {
  return redis.sMembers(`${REDIS_PREFIX}:blobs`);
}

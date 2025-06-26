import { createClient, type RedisClientType } from "redis";
import env from "@/env.ts";

const REDIS_PREFIX = "ct:toolshed:plaid-oauth";
const SESSION_TTL = 600; // 10 minutes in seconds

export type PlaidOAuthSession = {
  linkToken: string;
  authCellId: string;
  frontendUrl: string;
  integrationCharmId?: string;
  createdAt: string;
};

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

/**
 * Store OAuth session data in Redis
 * @param userEmail - User's email from tailscale header
 * @param session - Session data to store
 */
export async function storeOAuthSession(
  redis: RedisClientType,
  userEmail: string,
  session: PlaidOAuthSession,
): Promise<void> {
  const key = `${REDIS_PREFIX}:session:${userEmail}`;
  const value = JSON.stringify(session);
  
  // Store with TTL
  await redis.setEx(key, SESSION_TTL, value);
}

/**
 * Retrieve OAuth session data from Redis
 * @param userEmail - User's email from tailscale header
 * @returns Session data if found, null otherwise
 */
export async function getOAuthSession(
  redis: RedisClientType,
  userEmail: string,
): Promise<PlaidOAuthSession | null> {
  const key = `${REDIS_PREFIX}:session:${userEmail}`;
  const value = await redis.get(key);
  
  if (!value) {
    return null;
  }
  
  try {
    return JSON.parse(value) as PlaidOAuthSession;
  } catch (error) {
    console.error("Failed to parse OAuth session data:", error);
    return null;
  }
}

/**
 * Delete OAuth session data from Redis
 * @param userEmail - User's email from tailscale header
 */
export async function deleteOAuthSession(
  redis: RedisClientType,
  userEmail: string,
): Promise<void> {
  const key = `${REDIS_PREFIX}:session:${userEmail}`;
  await redis.del(key);
}

/**
 * Store link token to user email mapping
 * This allows us to look up sessions by link token if needed
 */
export async function storeLinkTokenMapping(
  redis: RedisClientType,
  linkToken: string,
  userEmail: string,
): Promise<void> {
  const key = `${REDIS_PREFIX}:linktoken:${linkToken}`;
  await redis.setEx(key, SESSION_TTL, userEmail);
}

/**
 * Get user email by link token
 */
export async function getUserEmailByLinkToken(
  redis: RedisClientType,
  linkToken: string,
): Promise<string | null> {
  const key = `${REDIS_PREFIX}:linktoken:${linkToken}`;
  return await redis.get(key);
}
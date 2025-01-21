import { SearchResult } from "../search.ts";
import { Logger, PrefixedLogger } from "../../prefixed-logger.ts";
import { getAllBlobs } from "@/lib/redis/redis.ts";
import { storage } from "@/storage.ts";
import type { RedisClientType } from "redis";

export async function scanForKey(
  phrase: string,
  redis: RedisClientType,
  logger: Logger,
): Promise<SearchResult> {
  const log = new PrefixedLogger(logger, "scanForKey");

  log.info(`Starting key scan for phrase: ${phrase}`);
  const allBlobs = await getAllBlobs(redis);
  log.info(`Retrieved ${allBlobs.length} blobs to scan`);

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of allBlobs) {
    if (blobKey.toLowerCase().includes(phrase.toLowerCase())) {
      try {
        const content = await storage.getBlob(blobKey);
        if (!content) {
          log.info(`No content found for key: ${blobKey}`);
          continue;
        }

        const blobData = JSON.parse(content);
        matchingExamples.push({
          key: blobKey,
          data: blobData,
        });
        log.info(`Found matching key: ${blobKey}`);
      } catch (error) {
        log.error(`Error processing key ${blobKey}:`, error);
        continue;
      }
    }
  }

  log.info(`Found ${matchingExamples.length} matching keys`);
  return {
    source: "key-search",
    results: matchingExamples,
  };
}

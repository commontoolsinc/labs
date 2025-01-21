import { storage } from "../../../routes/storage/blobby/blobby.handlers.ts";
import { getAllBlobs } from "../../../routes/storage/blobby/lib/redis.ts";
import { PrefixedLogger } from "../../prefixed-logger.ts";
import { SearchResult } from "../search.ts";

export async function scanForText(
  redis: any,
  phrase: string,
  logger: any,
): Promise<SearchResult> {
  const prefixedLogger = new PrefixedLogger(logger, "scanForText");
  prefixedLogger.info(`Starting text scan for phrase: ${phrase}`);
  const allBlobs = await getAllBlobs(redis);
  prefixedLogger.info(`Retrieved ${allBlobs.length} blobs to scan`);

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of allBlobs) {
    try {
      const content = await storage.getBlob(blobKey);
      if (!content) {
        prefixedLogger.info(`No content found for key: ${blobKey}`);
        continue;
      }

      const blobData = JSON.parse(content);
      const stringified = JSON.stringify(blobData).toLowerCase();

      if (stringified.includes(phrase.toLowerCase())) {
        matchingExamples.push({
          key: blobKey,
          data: blobData,
        });
        prefixedLogger.info(`Found text match in: ${blobKey}`);
      }
    } catch (error) {
      prefixedLogger.error(`Error processing key ${blobKey}:`, error);
      continue;
    }
  }

  prefixedLogger.info(`Found ${matchingExamples.length} text matches`);
  return {
    source: "text-search",
    results: matchingExamples,
  };
}

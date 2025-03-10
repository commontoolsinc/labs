import { SearchResult } from "../search.ts";
import { Logger, PrefixedLogger } from "@/lib/prefixed-logger.ts";
import { getAllBlobs, getBlob } from "../effects.ts";

export async function scanForKey(
  phrase: string,
  logger: Logger,
): Promise<SearchResult> {
  const log = new PrefixedLogger(logger, "scanForKey");

  log.info(`Starting key scan for phrase: ${phrase}`);
  const allBlobs = await getAllBlobs() as string[];
  log.info(`Retrieved ${allBlobs.length} blobs to scan`);

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of allBlobs) {
    if (blobKey.toLowerCase().includes(phrase.toLowerCase())) {
      try {
        const content = await getBlob(blobKey);
        if (!content) {
          log.info(`No content found for key: ${blobKey}`);
          continue;
        }

        const blobData = content as Record<string, unknown>;
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

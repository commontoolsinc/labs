import { Logger, PrefixedLogger } from "@/lib/prefixed-logger.ts";
import { SearchResult } from "../search.ts";
import { getAllBlobs, getBlob } from "../effects.ts";

export async function scanForText(
  phrase: string,
  logger: Logger,
): Promise<SearchResult> {
  const prefixedLogger = new PrefixedLogger(logger, "scanForText");
  prefixedLogger.info(`Starting text scan for phrase: ${phrase}`);
  const allBlobs = await getAllBlobs();
  prefixedLogger.info(`Retrieved ${allBlobs.length} blobs to scan`);

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of (allBlobs as string[])) {
    try {
      const content = await getBlob(blobKey);
      if (!content) {
        prefixedLogger.info(`No content found for key: ${blobKey}`);
        continue;
      }

      const blobData = content as Record<string, unknown>;
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

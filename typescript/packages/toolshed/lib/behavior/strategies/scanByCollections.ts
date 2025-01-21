import { storage } from "../../../routes/storage/blobby/blobby.handlers.ts";
import { SearchResult } from "../search.ts";
import { PrefixedLogger } from "../../prefixed-logger.ts";
import { generateText } from "../../llm/generateText.ts";

async function generateKeywords(
  query: string,
  logger: PrefixedLogger,
): Promise<string[]> {
  logger.info(`Generating keywords for query: ${query}`);

  const keywordPrompt = {
    model: "claude-3-5-sonnet",
    messages: [
      {
        role: "system",
        content:
          "Generate exactly 3 single-word collection names that would be relevant for organizing content related to this query. Return only a JSON array of 3 strings.",
      },
      {
        role: "user",
        content: query,
      },
    ],
    stream: false,
  };

  const keywordText = await generateText(keywordPrompt);
  const keywords = JSON.parse(keywordText.message.content);

  // Add original query if it's a single word
  if (query.trim().split(/\s+/).length === 1) {
    keywords.push(query.trim());
  }

  logger.info(`Generated keywords: ${keywords.join(", ")}`);
  return keywords;
}

export async function scanByCollections(
  redis: any,
  query: string,
  logger: any,
): Promise<SearchResult> {
  const prefixedLogger = new PrefixedLogger(logger, "scanByCollections");
  prefixedLogger.info("Starting collection scan");

  const keywords = await generateKeywords(query, prefixedLogger);
  const collectionKeys = keywords.map(keyword => `#${keyword}`);

  prefixedLogger.info(`Looking up collections: ${collectionKeys.join(", ")}`);

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const collectionKey of collectionKeys) {
    try {
      const content = await storage.getBlob(collectionKey);
      if (!content) {
        prefixedLogger.info(
          `No content found for collection: ${collectionKey}`,
        );
        continue;
      }

      const keys = JSON.parse(content);
      for (const key of keys) {
        try {
          const blobContent = await storage.getBlob(key);
          if (blobContent) {
            matchingExamples.push({
              key,
              data: JSON.parse(blobContent),
            });
            prefixedLogger.info(
              `Found item from collection ${collectionKey}: ${key}`,
            );
          }
        } catch (error) {
          prefixedLogger.error(
            `Error processing item ${key} from collection ${collectionKey}: ${error}`,
          );
        }
      }
    } catch (error) {
      prefixedLogger.error(
        `Error processing collection ${collectionKey}: ${error}`,
      );
      continue;
    }
  }

  prefixedLogger.info(`Found ${matchingExamples.length} collection matches`);
  return {
    source: "collection-match",
    results: matchingExamples,
  };
}

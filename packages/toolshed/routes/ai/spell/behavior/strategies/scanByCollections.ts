import { SearchResult } from "../search.ts";
import { Logger, PrefixedLogger } from "@/lib/prefixed-logger.ts";
import { getBlob } from "../effects.ts";
import { generateText } from "@/lib/llm.ts";
import { type LLMRequest } from "@commontools/llm/types";

async function generateKeywords(
  query: string,
  logger: Logger,
): Promise<string[]> {
  logger.info(`Generating keywords for query: ${query}`);
  const keywordPrompt: LLMRequest = {
    model: "claude-3-7-sonnet",
    messages: [
      {
        role: "user",
        content: query,
      },
    ],
    system:
      "Generate exactly 3 single-word collection names that would be relevant for organizing content related to this query. Return only a JSON array of 3 strings.",
    stream: false,
    cache: true,
  };
  const keywordText = await generateText(keywordPrompt);
  // Currently only handle string responses
  if (typeof keywordText !== "string") {
    throw new Error("Received unsupported LLM typed content.");
  }
  const keywords = JSON.parse(keywordText);

  // Add original query if it's a single word
  if (query.trim().split(/\s+/).length === 1) {
    keywords.push(query.trim());
  }

  logger.info(`Generated keywords: ${keywords.join(", ")}`);
  return keywords;
}

export async function scanByCollections(
  query: string,
  logger: Logger,
): Promise<SearchResult> {
  const prefixedLogger = new PrefixedLogger(logger, "scanByCollections");
  prefixedLogger.info("Starting collection scan");

  const keywords = await generateKeywords(query, prefixedLogger);
  const collectionKeys = keywords.map((keyword) => `#${keyword}`);

  prefixedLogger.info(`Looking up collections: ${collectionKeys.join(", ")}`);

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const collectionKey of collectionKeys) {
    try {
      const content = await getBlob(collectionKey);
      if (!content) {
        prefixedLogger.info(
          `No content found for collection: ${collectionKey}`,
        );
        continue;
      }

      if (!Array.isArray(content)) {
        prefixedLogger.error(
          `Expected array content for collection ${collectionKey}, got ${typeof content}`,
        );
        continue;
      }
      const keys = content as Array<string>;
      for (const key of keys) {
        try {
          const blobContent = await getBlob(key);
          if (blobContent) {
            matchingExamples.push({
              key,
              data: blobContent as Record<string, unknown>,
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

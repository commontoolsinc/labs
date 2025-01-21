import { generateTextCore } from "../../../routes/ai/llm/llm.handlers.ts";
import { storage } from "../../../routes/storage/blobby/blobby.handlers.ts";
import { getAllBlobs } from "../../../routes/storage/blobby/lib/redis.ts";
import { checkSchemaMatch } from "../schema-match.ts";
import { SearchResult } from "../search.ts";
import { PrefixedLogger } from "../../prefixed-logger.ts";

export async function generateSchema(query: string, logger: any): Promise<any> {
  const prefixedLogger = new PrefixedLogger(logger, "scanBySchema");
  prefixedLogger.info(`Generating schema for query: ${query}`);
  const schemaPrompt = {
    model: "claude-3-5-sonnet",
    messages: [
      {
        role: "system",
        content:
          "Generate a minimal JSON schema to match data that relates to this search query, aim for the absolute minimal number of fields that cature the essence of the data. (e.g. articles are really just title and url) Return only valid JSON schema.",
      },
      {
        role: "user",
        content: query,
      },
    ],
    stream: false,
  };

  const schemaText = await generateTextCore(schemaPrompt);
  const schema = JSON.parse(schemaText.message.content);
  prefixedLogger.info(`Generated schema:\n${JSON.stringify(schema, null, 2)}`);
  return schema;
}

export async function scanBySchema(
  redis: any,
  schema: any,
  logger: any,
): Promise<SearchResult> {
  const prefixedLogger = new PrefixedLogger(logger, "scanBySchema");
  prefixedLogger.info("Starting schema scan");
  prefixedLogger.info(`Using schema:\n${JSON.stringify(schema, null, 2)}`);
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
      const matches = checkSchemaMatch(blobData, schema);

      if (matches) {
        matchingExamples.push({
          key: blobKey,
          data: blobData,
        });
        prefixedLogger.info(`Found schema match in: ${blobKey}`);
      }
    } catch (error) {
      prefixedLogger.error(`Error processing key ${blobKey}: ${error}`);
      continue;
    }
  }

  prefixedLogger.info(`Found ${matchingExamples.length} schema matches`);
  return {
    source: "schema-match",
    results: matchingExamples,
  };
}

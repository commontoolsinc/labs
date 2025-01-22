import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { SearchResult } from "../search.ts";
import { Logger, PrefixedLogger } from "@/lib/prefixed-logger.ts";
import type { RedisClientType } from "redis";
import { generateText, getBlob, getAllBlobs } from "../effects.ts";
import { Schema } from 'jsonschema'

export async function generateSchema(
  query: string,
  logger: Logger,
): Promise<unknown> {
  const prefixedLogger = new PrefixedLogger(logger, "scanBySchema");
  prefixedLogger.info(`Generating schema for query: ${query}`);
  const schemaPrompt = {
    model: "claude-3-5-sonnet",
    messages: [
      {
        role: "user" as const,
        content: query,
      },
    ],
    system: "Generate a minimal JSON schema to match data that relates to this search query, aim for the absolute minimal number of fields that cature the essence of the data. (e.g. articles are really just title and url) Return only valid JSON schema.",
    stream: false,
  };

  const schemaText = await generateText(schemaPrompt);
  const schema = JSON.parse(schemaText);
  prefixedLogger.info(`Generated schema:\n${JSON.stringify(schema, null, 2)}`);
  return schema;
}

export async function scanBySchema(
  schema: unknown,
  logger: Logger,
): Promise<SearchResult> {
  const prefixedLogger = new PrefixedLogger(logger, "scanBySchema");
  prefixedLogger.info("Starting schema scan");
  prefixedLogger.info(`Using schema:\n${JSON.stringify(schema, null, 2)}`);
  const allBlobs = await getAllBlobs();
  prefixedLogger.info(`Retrieved ${allBlobs.length} blobs to scan`);

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of allBlobs) {
    try {
      const content = await getBlob(blobKey);
      if (!content) {
        prefixedLogger.info(`No content found for key: ${blobKey}`);
        continue;
      }

      const blobData = JSON.parse(content);
      const matches = checkSchemaMatch(blobData, schema as Schema);

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

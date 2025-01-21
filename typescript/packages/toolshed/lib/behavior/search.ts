import { BehaviourTree, State } from "mistreevous";
import { getAllBlobs } from "../../routes/storage/blobby/lib/redis.ts";
import { checkSchemaMatch } from "./schema-match.ts";
import { BaseAgent } from "./agent.ts";
import { generateTextCore } from "../../routes/ai/llm/llm.handlers.ts";
import { storage } from "../../routes/storage/blobby/blobby.handlers.ts";

export interface SearchResult {
  source: string;
  results: Array<{
    key: string;
    data: Record<string, unknown>;
  }>;
}

export interface CombinedResults {
  results: SearchResult[];
  timestamp: number;
  metadata: {
    totalDuration: number;
    stepDurations: Record<string, number>;
    logs: string[];
  };
}

// Search behavior implementation
async function scanForKey(
  redis: any,
  phrase: string,
  logger: any,
): Promise<SearchResult> {
  logger.info(`[SearchAgent/keyScan] Starting key scan for phrase: ${phrase}`);
  const allBlobs = await getAllBlobs(redis);
  logger.info(
    `[SearchAgent/keyScan] Retrieved ${allBlobs.length} blobs to scan`,
  );

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of allBlobs) {
    if (blobKey.toLowerCase().includes(phrase.toLowerCase())) {
      try {
        const content = await storage.getBlob(blobKey);
        if (!content) {
          logger.info(
            `[SearchAgent/keyScan] No content found for key: ${blobKey}`,
          );
          continue;
        }

        const blobData = JSON.parse(content);
        matchingExamples.push({
          key: blobKey,
          data: blobData,
        });
        logger.info(`[SearchAgent/keyScan] Found matching key: ${blobKey}`);
      } catch (error) {
        logger.error(
          `[SearchAgent/keyScan] Error processing key ${blobKey}:`,
          error,
        );
        continue;
      }
    }
  }

  logger.info(
    `[SearchAgent/keyScan] Found ${matchingExamples.length} matching keys`,
  );
  return {
    source: "key-search",
    results: matchingExamples,
  };
}

async function scanForText(
  redis: any,
  phrase: string,
  logger: any,
): Promise<SearchResult> {
  logger.info(
    `[SearchAgent/textScan] Starting text scan for phrase: ${phrase}`,
  );
  const allBlobs = await getAllBlobs(redis);
  logger.info(
    `[SearchAgent/textScan] Retrieved ${allBlobs.length} blobs to scan`,
  );

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of allBlobs) {
    try {
      const content = await storage.getBlob(blobKey);
      if (!content) {
        logger.info(
          `[SearchAgent/textScan] No content found for key: ${blobKey}`,
        );
        continue;
      }

      const blobData = JSON.parse(content);
      const stringified = JSON.stringify(blobData).toLowerCase();

      if (stringified.includes(phrase.toLowerCase())) {
        matchingExamples.push({
          key: blobKey,
          data: blobData,
        });
        logger.info(`[SearchAgent/textScan] Found text match in: ${blobKey}`);
      }
    } catch (error) {
      logger.error(
        `[SearchAgent/textScan] Error processing key ${blobKey}:`,
        error,
      );
      continue;
    }
  }

  logger.info(
    `[SearchAgent/textScan] Found ${matchingExamples.length} text matches`,
  );
  return {
    source: "text-search",
    results: matchingExamples,
  };
}

async function generateSchema(query: string, logger: any): Promise<any> {
  logger.info(`[SearchAgent/schemaGen] Generating schema for query: ${query}`);
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
  logger.info(
    `[SearchAgent/schemaGen] Generated schema:\n${JSON.stringify(schema, null, 2)}`,
  );
  return schema;
}

async function scanBySchema(
  redis: any,
  schema: any,
  logger: any,
): Promise<SearchResult> {
  logger.info(`[SearchAgent/schemaScan] Starting schema scan`);
  logger.info(
    `[SearchAgent/schemaScan] Using schema:\n${JSON.stringify(schema, null, 2)}`,
  );
  const allBlobs = await getAllBlobs(redis);
  logger.info(
    `[SearchAgent/schemaScan] Retrieved ${allBlobs.length} blobs to scan`,
  );

  const matchingExamples: Array<{
    key: string;
    data: Record<string, unknown>;
  }> = [];

  for (const blobKey of allBlobs) {
    try {
      const content = await storage.getBlob(blobKey);
      if (!content) {
        logger.info(
          `[SearchAgent/schemaScan] No content found for key: ${blobKey}`,
        );
        continue;
      }

      const blobData = JSON.parse(content);
      const matches = checkSchemaMatch(blobData, schema);

      if (matches) {
        matchingExamples.push({
          key: blobKey,
          data: blobData,
        });
        logger.info(
          `[SearchAgent/schemaScan] Found schema match in: ${blobKey}`,
        );
      }
    } catch (error) {
      logger.error(
        `[SearchAgent/schemaScan] Error processing key ${blobKey}:`,
        error,
      );
      continue;
    }
  }

  logger.info(
    `[SearchAgent/schemaScan] Found ${matchingExamples.length} schema matches`,
  );
  return {
    source: "schema-match",
    results: matchingExamples,
  };
}

class SearchAgent extends BaseAgent {
  [key: string]: any;
  private query: string = "";
  private results: SearchResult[] = [];
  private searchPromises: Map<string, Promise<SearchResult>> = new Map();
  private redis: any;

  constructor(logger: any, query: string, redis: any) {
    super(logger, "SearchAgent");
    this.query = query;
    this.redis = redis;
    this.resetSearch();
  }

  resetSearch() {
    this.results = [];
    this.searchPromises.clear();
    this.stepDurations = {};
    this.logs = [];
    this.logger.info(`[SearchAgent] Reset search state`);
  }

  async InitiateSearch(): Promise<State> {
    return this.measureStep("InitiateSearch", async () => {
      this.resetSearch();
      this.logger.info(
        `[SearchAgent] Initiated search with query: ${this.query}`,
      );
      return State.SUCCEEDED;
    });
  }

  async SearchKeyMatch(): Promise<State> {
    return this.measureStep("SearchKeyMatch", async () => {
      if (!this.searchPromises.has("key-search")) {
        this.logger.info(`[SearchAgent] Starting key match search`);
        this.searchPromises.set(
          "key-search",
          scanForKey(this.redis, this.query, this.logger),
        );
      }
      return State.SUCCEEDED;
    });
  }

  async SearchTextMatch(): Promise<State> {
    return this.measureStep("SearchTextMatch", async () => {
      if (!this.searchPromises.has("text-search")) {
        this.logger.info(`[SearchAgent] Starting text match search`);
        this.searchPromises.set(
          "text-search",
          scanForText(this.redis, this.query, this.logger),
        );
      }
      return State.SUCCEEDED;
    });
  }

  async SearchSchemaMatch(): Promise<State> {
    return this.measureStep("SearchSchemaMatch", async () => {
      if (!this.searchPromises.has("schema-match")) {
        this.logger.info(`[SearchAgent] Starting schema match search`);
        const schema = await generateSchema(this.query, this.logger);
        this.logger.info(`[SearchAgent] Generated schema for query`);

        this.searchPromises.set(
          "schema-match",
          scanBySchema(this.redis, schema, this.logger),
        );
      }
      return State.SUCCEEDED;
    });
  }

  async CollectResults(): Promise<State> {
    return this.measureStep("CollectResults", async () => {
      try {
        this.logger.info(`[SearchAgent] Collecting results from all sources`);
        const allResults = await Promise.all(this.searchPromises.values());

        // Deduplicate results based on keys
        const seenKeys = new Set<string>();
        const dedupedResults = allResults
          .map(resultSet => ({
            source: resultSet.source,
            results: resultSet.results.filter(result => {
              if (seenKeys.has(result.key)) return false;
              seenKeys.add(result.key);
              return true;
            }),
          }))
          .filter(result => result.results.length > 0);

        this.results = dedupedResults;
        this.logger.info(
          `[SearchAgent] Collected ${this.results.length} result sets after deduplication`,
        );
        return State.SUCCEEDED;
      } catch (error) {
        this.logger.error(`[SearchAgent] Error collecting results:`, error);
        return State.FAILED;
      }
    });
  }

  getCombinedResults(): CombinedResults {
    const metadata = this.getMetadata();
    this.logger.info(
      `[SearchAgent] Total execution time: ${metadata.totalDuration}ms`,
    );
    return {
      results: this.results,
      timestamp: Date.now(),
      metadata,
    };
  }
}

const searchTreeDefinition = `root {
  sequence {
    action [InitiateSearch]
    parallel {
      action [SearchKeyMatch]
      action [SearchTextMatch]
      action [SearchSchemaMatch]
    }
    action [CollectResults]
  }
}`;

export async function performSearch(
  query: string,
  logger: any,
  redis: any,
): Promise<CombinedResults> {
  return new Promise((resolve, reject) => {
    const agent = new SearchAgent(logger, query, redis);
    const tree = new BehaviourTree(searchTreeDefinition, agent);

    logger.info("[SearchAgent] Starting behavior tree execution");

    const stepUntilComplete = () => {
      tree.step();
      const state = tree.getState();
      if (state === State.SUCCEEDED) {
        logger.info("[SearchAgent] Behavior tree completed successfully");
        resolve(agent.getCombinedResults());
      } else if (state === State.FAILED) {
        logger.error("[SearchAgent] Behavior tree failed");
        reject(new Error("Search failed"));
      } else {
        setTimeout(stepUntilComplete, 100);
      }
    };

    stepUntilComplete();
  });
}

import { BehaviourTree, State } from "mistreevous";
import { BaseAgent } from "@/lib/agent.ts";
import { scanForKey } from "./strategies/scanForKey.ts";
import { scanForText } from "./strategies/scanForText.ts";
import { generateSchema, scanBySchema } from "./strategies/scanBySchema.ts";
import { scanByCollections } from "./strategies/scanByCollections.ts";
import { Logger } from "@/lib/prefixed-logger.ts";

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

const searchTreeDefinition = `root {
  sequence {
    action [InitiateSearch]
    parallel {
      action [SearchKeyMatch]
      action [SearchTextMatch]
      action [SearchSchemaMatch]
      action [SearchCollectionMatch]
    }
    action [CollectResults]
  }
}`;

function resolve<T>(value: T) {
  return new Promise<T>((resolve) => resolve(value));
}

class SearchAgent extends BaseAgent {
  [key: string]: unknown;
  private query: string = "";
  private results: SearchResult[] = [];
  private searchPromises: Map<string, Promise<SearchResult>> = new Map();

  constructor(query: string, logger: Logger) {
    super(logger, "SearchAgent");
    this.query = query;
    this.resetSearch();
  }

  resetSearch() {
    this.results = [];
    this.searchPromises.clear();
    this.stepDurations = {};
    this.logger.info("Reset search state");
  }

  InitiateSearch(): Promise<State> {
    return this.measureStep("InitiateSearch", async () => {
      this.resetSearch();
      this.logger.info(`Initiated search with query: ${this.query}`);
      return await resolve(State.SUCCEEDED);
    });
  }

  SearchKeyMatch(): Promise<State> {
    return this.measureStep("SearchKeyMatch", async () => {
      if (!this.searchPromises.has("key-search")) {
        this.logger.info("Starting key match search");
        this.searchPromises.set(
          "key-search",
          scanForKey(this.query, this.logger),
        );
      }
      return await resolve(State.SUCCEEDED);
    });
  }

  SearchTextMatch(): Promise<State> {
    return this.measureStep("SearchTextMatch", async () => {
      if (!this.searchPromises.has("text-search")) {
        this.logger.info("Starting text match search");
        this.searchPromises.set(
          "text-search",
          scanForText(this.query, this.logger),
        );
      }
      return await resolve(State.SUCCEEDED);
    });
  }

  SearchSchemaMatch(): Promise<State> {
    return this.measureStep("SearchSchemaMatch", async () => {
      if (!this.searchPromises.has("schema-match")) {
        this.logger.info("Starting schema match search");
        const schema = await generateSchema(this.query, this.logger);
        this.logger.info("Generated schema for query");

        this.searchPromises.set(
          "schema-match",
          scanBySchema(schema, this.logger),
        );
      }
      return await resolve(State.SUCCEEDED);
    });
  }

  SearchCollectionMatch(): Promise<State> {
    return this.measureStep("SearchCollectionMatch", async () => {
      if (!this.searchPromises.has("collection-match")) {
        this.logger.info("Starting collection match search");
        this.searchPromises.set(
          "collection-match",
          scanByCollections(this.query, this.logger),
        );
      }
      return await resolve(State.SUCCEEDED);
    });
  }

  CollectResults(): Promise<State> {
    return this.measureStep("CollectResults", async () => {
      try {
        this.logger.info("Collecting results from all sources");
        const allResults = await Promise.all(this.searchPromises.values());

        const seenKeys = new Set<string>();
        const dedupedResults = allResults
          .map((resultSet) => ({
            source: resultSet.source,
            results: resultSet.results.filter((result) => {
              if (seenKeys.has(result.key)) return false;
              seenKeys.add(result.key);
              return true;
            }),
          }))
          .filter((result) => result.results.length > 0);

        this.results = dedupedResults;
        this.logger.info(
          `Collected ${this.results.length} result sets after deduplication`,
        );
        return await resolve(State.SUCCEEDED);
      } catch (error) {
        this.logger.error("Error collecting results:", error);
        return await resolve(State.FAILED);
      }
    });
  }

  getCombinedResults(): CombinedResults {
    const metadata = this.getMetadata();
    metadata.logs = [...this.logger.getLogs()];
    this.logger.info(`${metadata.logs.length} log messages recorded`);
    this.logger.info(`Total execution time: ${metadata.totalDuration}ms`);
    return {
      results: this.results,
      timestamp: Date.now(),
      metadata,
    };
  }
}

export function performSearch(
  query: string,
  logger: Logger,
): Promise<CombinedResults> {
  return new Promise((resolve, reject) => {
    const agent = new SearchAgent(query, logger);
    const tree = new BehaviourTree(searchTreeDefinition, agent);

    logger.info("Starting behavior tree execution");

    const stepUntilComplete = () => {
      tree.step();
      const state = tree.getState();
      if (state === State.SUCCEEDED) {
        logger.info("Behavior tree completed successfully");
        resolve(agent.getCombinedResults());
      } else if (state === State.FAILED) {
        logger.error("Behavior tree failed");
        reject(new Error("Search failed"));
      } else {
        setTimeout(stepUntilComplete, 100);
      }
    };

    stepUntilComplete();
  });
}

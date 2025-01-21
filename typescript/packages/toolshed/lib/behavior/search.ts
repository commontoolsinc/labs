import { BehaviourTree, State } from "mistreevous";
import { getAllBlobs } from "../../routes/storage/blobby/lib/redis.ts";
import { checkSchemaMatch } from "./schema-match.ts";

// Type for search results from any source
export interface SearchResult {
  source: string;
  results: Array<{
    key: string;
    data: Record<string, unknown>;
  }>;
}

// Type for the combined final results
export interface CombinedResults {
  results: SearchResult[];
  timestamp: number;
  metadata: {
    totalDuration: number;
    stepDurations: Record<string, number>;
    logs: string[];
  };
}

class SearchAgent {
  [key: string]: any;
  private query: string = "";
  private results: SearchResult[] = [];
  private logger: any;
  private redis: any;
  private agentName = "SearchAgent";
  private searchPromises: Map<string, Promise<SearchResult>> = new Map();
  private stepDurations: Record<string, number> = {};
  private logs: string[] = [];
  private startTime: number = 0;

  constructor(logger: any, query: string, redis: any) {
    this.logger = {
      info: (msg: string) => {
        this.logs.push(msg);
        logger.info(msg);
      },
      error: (msg: string, error?: any) => {
        this.logs.push(`ERROR: ${msg}`);
        logger.error(msg, error);
      },
    };
    this.query = query;
    this.redis = redis;
    this.startTime = Date.now();
    this.resetSearch();
  }

  resetSearch() {
    this.results = [];
    this.searchPromises.clear();
    this.stepDurations = {};
    this.logs = [];
    this.logger.info(`${this.agentName}: Reset search state`);
  }

  private measureStep(
    stepName: string,
    fn: () => Promise<State>,
  ): Promise<State> {
    const start = Date.now();
    return fn().then(result => {
      this.stepDurations[stepName] = Date.now() - start;
      this.logger.info(
        `${this.agentName}: ${stepName} took ${this.stepDurations[stepName]}ms`,
      );
      return result;
    });
  }

  async InitiateSearch(): Promise<State> {
    return this.measureStep("InitiateSearch", async () => {
      this.resetSearch();
      this.logger.info(
        `${this.agentName}: Initiated search with query: ${this.query}`,
      );
      return State.SUCCEEDED;
    });
  }

  async SearchDatabase(): Promise<State> {
    return this.measureStep("SearchDatabase", async () => {
      if (!this.searchPromises.has("database")) {
        this.logger.info(`${this.agentName}: Starting database search`);
        this.searchPromises.set("database", this.simulateDBSearch());
      }
      return State.SUCCEEDED;
    });
  }

  async SearchAPI(): Promise<State> {
    return this.measureStep("SearchAPI", async () => {
      if (!this.searchPromises.has("api")) {
        this.logger.info(`${this.agentName}: Starting API search`);
        this.searchPromises.set("api", this.simulateAPISearch());
      }
      return State.SUCCEEDED;
    });
  }

  async SearchCache(): Promise<State> {
    return this.measureStep("SearchCache", async () => {
      if (!this.searchPromises.has("cache")) {
        this.logger.info(`${this.agentName}: Starting cache search`);
        this.searchPromises.set("cache", this.simulateCacheSearch());
      }
      return State.SUCCEEDED;
    });
  }

  async CollectResults(): Promise<State> {
    return this.measureStep("CollectResults", async () => {
      try {
        this.logger.info(
          `${this.agentName}: Collecting results from all sources`,
        );
        const allResults = await Promise.all(this.searchPromises.values());
        this.results = allResults.filter(result => result.results.length > 0);
        this.logger.info(
          `${this.agentName}: Collected ${this.results.length} result sets`,
        );
        return State.SUCCEEDED;
      } catch (error) {
        this.logger.error(
          `${this.agentName}: Error collecting results:`,
          error,
        );
        return State.FAILED;
      }
    });
  }

  getCombinedResults(): CombinedResults {
    const totalDuration = Date.now() - this.startTime;
    this.logger.info(
      `${this.agentName}: Total execution time: ${totalDuration}ms`,
    );
    return {
      results: this.results,
      timestamp: Date.now(),
      metadata: {
        totalDuration,
        stepDurations: this.stepDurations,
        logs: this.logs,
      },
    };
  }

  private async simulateDBSearch(): Promise<SearchResult> {
    const startTime = Date.now();
    const blobs = await getAllBlobs(this.redis);
    const duration = Date.now() - startTime;
    this.logger.info(
      `${this.agentName}: Database search completed in ${duration}ms`,
    );
    this.logger.info(
      `${this.agentName}: Found ${blobs.length} blobs in database`,
    );
    return {
      source: "database",
      results: [
        {
          key: "db-key-1",
          data: { message: `DB result for: ${this.query}`, blobs },
        },
      ],
    };
  }

  private async simulateAPISearch(): Promise<SearchResult> {
    const startTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, 1500));
    const duration = Date.now() - startTime;
    this.logger.info(
      `${this.agentName}: API search completed in ${duration}ms`,
    );
    return {
      source: "api",
      results: [
        {
          key: "api-key-1",
          data: { message: `API result for: ${this.query}` },
        },
      ],
    };
  }

  private async simulateCacheSearch(): Promise<SearchResult> {
    const startTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, 500));
    const duration = Date.now() - startTime;
    this.logger.info(
      `${this.agentName}: Cache search completed in ${duration}ms`,
    );
    return {
      source: "cache",
      results: [
        {
          key: "cache-key-1",
          data: { message: `Cache result for: ${this.query}` },
        },
      ],
    };
  }
}

const searchTreeDefinition = `root {
  sequence {
    action [InitiateSearch]
    parallel {
      action [SearchDatabase]
      action [SearchAPI]
      action [SearchCache]
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

    logger.info("SearchAgent: Starting behavior tree execution");

    const stepUntilComplete = () => {
      tree.step();
      const state = tree.getState();
      if (state === State.SUCCEEDED) {
        logger.info("SearchAgent: Behavior tree completed successfully");
        resolve(agent.getCombinedResults());
      } else if (state === State.FAILED) {
        logger.error("SearchAgent: Behavior tree failed");
        reject(new Error("Search failed"));
      } else {
        setTimeout(stepUntilComplete, 100);
      }
    };

    stepUntilComplete();
  });
}

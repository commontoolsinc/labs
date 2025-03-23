// labs/behavior/fetcher.ts
import { Behavior, FX, wait } from "./state-machine.ts";
import { createCommandDef, CommandsFromRegistry } from "./behavior-utils.ts";

// Enhanced command registry with fetch-related commands
export const CommandRegistry = {
  fetch: createCommandDef(
    "fetch",
    "Fetch data from a URL",
    {
      url: { type: "string", description: "URL to fetch data from" },
      method: { type: "string", description: "HTTP method to use (defaults to GET)" },
      body: { type: "object", description: "Request body" },
      headers: { type: "object", description: "Request headers" },
    },
    ["url"],
    {
      // Wait until loading is done
      condition: (state) => state.isLoading === false,
      timeout: 10000,
      // Extract the response from the last history item
      resultExtractor: (state) => {
        const history = state.history;
        const lastRequest = history[history.length - 1];
        return lastRequest?.response;
      },
      // Check if there was an error
      errorDetector: (state) => {
        const history = state.history;
        const lastRequest = history[history.length - 1];
        return {
          isError: lastRequest?.status === "error",
          message: lastRequest?.error,
        };
      },
    },
  ),
  clearCache: createCommandDef(
    "clearCache",
    "Clear the request cache",
    {},
    [],
    {
      // Simple check that state changed
      condition: (state, previousState) =>
        Object.keys(state.cache).length === 0 &&
        Object.keys(previousState.cache).length > 0,
    },
  ),
  clearHistory: createCommandDef(
    "clearHistory",
    "Clear the request history",
    {},
    [],
    {
      // Simple check that state changed
      condition: (state, previousState) =>
        state.history.length === 0 &&
        previousState.history.length > 0,
    },
  ),
};

// Derive Command type from the registry
export type Command = CommandsFromRegistry<typeof CommandRegistry> | 
  { 
    type: "fetchSuccess";
    url: string;
    response: unknown;
    cacheKey: string;
  } |
  {
    type: "fetchError";
    url: string;
    error: string;
  };

// Define request history item
interface RequestHistoryItem {
  url: string;
  method: string;
  timestamp: number;
  status: "pending" | "success" | "error";
  response?: unknown;
  error?: string;
}

// Model type
export type Model = {
  cache: Record<string, { data: unknown; timestamp: number }>;
  history: RequestHistoryItem[];
  isLoading: boolean;
};

// Helper to create a cache key
function createCacheKey(url: string, method = "GET"): string {
  return `${method}-${url}`;
}

// Effect to perform a fetch operation
// This will be yielded from the generator
class FetchEffect<T = unknown> {
  constructor(
    public url: string,
    public options?: RequestInit
  ) {}

  // This will be executed by the state machine runner
  async execute(): Promise<T> {
    try {
      const response = await fetch(this.url, this.options);
      const contentType = response.headers.get("content-type") || "";
      
      // Try to parse as JSON but fallback to text, based on content type
      if (contentType.includes("application/json")) {
        return await response.json() as T;
      } else {
        return await response.text() as unknown as T;
      }
    } catch (error) {
      throw error;
    }
  }
}

// Create behavior for our state machine
export const behavior: Behavior<Model, Command> = {
  *init() {
    console.error("Initializing fetcher behavior service");
    return {
      cache: {},
      history: [],
      isLoading: false,
    };
  },

  *update(model: Model, command: Command) {
    console.error(`Handling command: ${JSON.stringify(command)}`);

    switch (command.type) {
      case "fetch": {
        const url = command.url as string;
        const method = (command.method as string) || "GET";
        const headers = command.headers as Record<string, string> || {};
        const body = command.body;

        // Create cache key
        const cacheKey = createCacheKey(url, method);

        // Check if we have a cached response and it's fresh (less than 5 minutes old)
        const cachedResponse = model.cache[cacheKey];
        const now = Date.now();

        if (cachedResponse && now - cachedResponse.timestamp < 5 * 60 * 1000) {
          // Add to history that we're using cached data
          const newHistory = [...model.history, {
            url,
            method,
            timestamp: now,
            status: "success",
            response: cachedResponse.data,
          }];

          return { ...model, history: newHistory };
        }

        // Add to history that we're starting a request
        const newHistory = [...model.history, {
          url,
          method,
          timestamp: now,
          status: "pending",
        }];

        // Start loading
        const updatedModel = { ...model, history: newHistory, isLoading: true };

        // Prepare options for fetch
        const options: RequestInit = {
          method,
          headers: headers || {},
        };
        
        if (body) {
          options.body = typeof body === "object" ? JSON.stringify(body) : String(body);
        }
        
        // Yield a fetch effect - this will be handled by the state machine runner
        // The result will be available when we return to the generator
        try {
          // Use the state machine's wait function to suspend until fetch completes
          const data = yield* wait(new FetchEffect(url, options).execute());
          
          // When we get here, the fetch has completed successfully
          // We'll send a fetchSuccess command to update the state
          yield {
            type: "fetchSuccess",
            url,
            response: data,
            cacheKey,
          };
          
          // Return the updated model
          return updatedModel;
        } catch (error) {
          // If an error occurred, send an error command
          yield {
            type: "fetchError",
            url,
            error: error instanceof Error ? error.message : String(error),
          };
          
          // Return the updated model
          return updatedModel;
        }
      }

      case "fetchSuccess": {
        const url = command.url;
        const cacheKey = command.cacheKey;
        const response = command.response;

        // Update the last history item with the response
        const newHistory = [...model.history];
        const lastIndex = newHistory.length - 1;

        if (lastIndex >= 0) {
          newHistory[lastIndex] = {
            ...newHistory[lastIndex],
            status: "success",
            response,
          };
        }

        // Update cache with the new response
        const newCache = {
          ...model.cache,
          [cacheKey]: {
            data: response,
            timestamp: Date.now(),
          },
        };

        console.error(`Fetch success, updating model`);
        return {
          ...model,
          history: newHistory,
          cache: newCache,
          isLoading: false,
        };
      }

      case "fetchError": {
        const url = command.url;
        const error = command.error;

        // Update the last history item with the error
        const newHistory = [...model.history];
        const lastIndex = newHistory.length - 1;

        if (lastIndex >= 0) {
          newHistory[lastIndex] = {
            ...newHistory[lastIndex],
            status: "error",
            error,
          };
        }

        console.error(`Fetch error: ${error}`);
        return { ...model, history: newHistory, isLoading: false };
      }

      case "clearCache": {
        return { ...model, cache: {} };
      }

      case "clearHistory": {
        return { ...model, history: [] };
      }

      default:
        return model;
    }
  }
};
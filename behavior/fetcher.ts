// labs/behavior/fetcher.ts
import { Behavior, FX, Wait } from "./state-machine.ts";

// Define effect for HTTP requests
export interface FetchFX<T> extends FX<T> {
  type: "fetch";
  url: string;
  options?: RequestInit;
}

// Create fetch effect helper
export function fetch<T>(url: string, options?: RequestInit): FetchFX<T> {
  return {
    type: "fetch",
    url,
    options,
  };
}

// Enhanced command definition with waiting conditions
interface CommandDef<
  P extends Record<string, unknown> = Record<string, never>,
> {
  type: string;
  description: string;
  params: P;
  required?: Array<keyof P>;
  // Wait condition metadata
  wait?: {
    condition: (state: any, previousState: any) => boolean;
    timeout?: number;
    resultExtractor?: (state: any) => any;
    errorDetector?: (state: any) => { isError: boolean; message?: string };
  };
}

// Enhanced command factory
const createCommand = <T extends string, P extends Record<string, unknown>>(
  type: T,
  description: string,
  params: P = {} as P,
  required: Array<keyof P> = [],
  wait?: {
    condition: (state: any, previousState: any) => boolean;
    timeout?: number;
    resultExtractor?: (state: any) => any;
    errorDetector?: (state: any) => { isError: boolean; message?: string };
  },
): CommandDef<P> => ({
  type,
  description,
  params,
  required,
  wait,
});

export const CommandRegistry = {
  fetch: createCommand(
    "fetch",
    "Fetch data from a URL",
    {
      url: { type: "string", description: "URL to fetch data from" },
      method: { type: "string", description: "HTTP method to use" },
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
  clearCache: createCommand(
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
  clearHistory: createCommand(
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
  retryRequest: createCommand(
    "retryRequest",
    "Retry a previous request",
    {
      index: { type: "integer", description: "Index of the request to retry" },
    },
    ["index"],
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
    },
  ),
};

// Derive Command type from the registry
type CommandRegistry = typeof CommandRegistry;
type CommandTypes = keyof CommandRegistry;

// Define payload type for each command based on its params
type CommandPayload<T extends CommandTypes> = {
  [K in keyof CommandRegistry[T]["params"]]: unknown;
};

// Final Command type derived from the registry
export type Command =
  | {
    [T in CommandTypes]: { type: T } & CommandPayload<T>;
  }[CommandTypes]
  | {
    type: "fetchSuccess";
    url: string;
    method: string;
    response: unknown;
    cacheKey: string;
  }
  | {
    type: "fetchError";
    url: string;
    method: string;
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
function createCacheKey(url: string, options?: RequestInit): string {
  return `${options?.method || "GET"}-${url}`;
}

// Create behavior for our state machine
export const behavior: Behavior<Model, Command> = {
  *init() {
    console.error("Initializing behavior service");
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
        const cacheKey = createCacheKey(url, { method, headers, body });

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
        const newModel = { ...model, history: newHistory, isLoading: true };

        try {
          // Instead of yielding the fetch effect directly, use our FX type
          const options: RequestInit = {
            method,
            headers: headers || {},
          };

          if (body) {
            options.body = typeof body === "object" ? JSON.stringify(body) : body;
          }

          console.error(`Creating fetch effect for: ${url}`);
          const fetchEffect = {
            type: "fetch",
            url,
            options,
          };
          yield fetchEffect;
        } catch (error) {
          console.error(`Error creating fetch effect: ${error}`);
        }

        return newModel;
      }

      case "fetchSuccess": {
        const url = command.url;
        const method = command.method;
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
        const method = command.method;
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

      case "retryRequest": {
        const index = command.index as number;
        const requestToRetry = model.history[index];

        if (!requestToRetry) {
          return model;
        }

        try {
          // Create a new fetch effect from the history item
          const fetchEffect = {
            type: "fetch",
            url: requestToRetry.url,
            options: {
              method: requestToRetry.method || "GET",
            },
          };
          yield fetchEffect;
        } catch (error) {
          console.error(`Error creating retry fetch effect: ${error}`);
        }

        // Add to history that we're retrying
        const newHistory = [...model.history, {
          ...requestToRetry,
          timestamp: Date.now(),
          status: "pending",
        }];

        return { ...model, history: newHistory, isLoading: true };
      }

      default:
        return model;
    }
  },

  // Handle effects
  *handle(effect: FX<Command>) {
    console.error(`Handling effect: ${JSON.stringify(effect)}`);

    if (effect && typeof effect === 'object' && 'type' in effect && effect.type === "fetch") {
      try {
        console.error(`Executing fetch to ${effect.url}`);
        // Use global fetch function available in Deno
        const response = yield new Wait(globalThis.fetch(effect.url, effect.options));
        let data;

        // Try to parse as JSON, but fallback to text if it fails
        try {
          // Properly wrap the JSON parsing promise in a Wait object
          data = yield new Wait(response.json());
        } catch {
          // Properly wrap the text parsing promise in a Wait object
          data = yield new Wait(response.text());
        }

        console.error(
          `Fetch successful with data: ${
            JSON.stringify(data).substring(0, 100)
          }...`,
        );

        // Create a success command
        const url = effect.url;
        const method = effect.options?.method || "GET";
        const cacheKey = createCacheKey(url, effect.options);

        return {
          type: "fetchSuccess",
          url,
          method,
          response: data,
          cacheKey,
        };
      } catch (error) {
        console.error(`Fetch error: ${error}`);

        // Create an error command
        return {
          type: "fetchError",
          url: effect.url,
          method: effect.options?.method || "GET",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return null;
  },

  // We no longer need this process method since we're handling fetch responses directly
  *process(model, _effectResult) {
    return model;
  },
};

#!/usr/bin/env -S deno run --watch --allow-net --allow-env --allow-run --allow-read --allow-write

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequest,
  ReadResourceRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { behavior as counterBehavior } from "./counter.ts";
import { service, send } from "./state-machine.ts";

// Extremely basic example MCP server that should be able to connect
const DEBUG = true;

// Create simple tools
const echoTool: Tool = {
  name: "echo",
  description: "Echoes back the input text",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to echo back",
      },
    },
    required: ["text"],
  },
};

const incrementTool: Tool = {
  name: "increment",
  description: "Increments the counter by a given amount",
  inputSchema: {
    type: "object",
    properties: {
      amount: {
        type: "number",
        description: "The amount to increment by (defaults to 1)",
      },
    },
    required: [],
  },
};

const fetchTool: Tool = {
  name: "fetch",
  description: "Fetch data from a URL",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string", 
        description: "URL to fetch data from"
      },
      method: {
        type: "string", 
        description: "HTTP method to use (defaults to GET)"
      },
      headers: {
        type: "object", 
        description: "Request headers"
      },
      body: {
        type: "object", 
        description: "Request body"
      }
    },
    required: ["url"],
  },
};

// Set up global state
const state = {
  counter: 0,
  messages: [],
  fetchHistory: [],
  fetchCache: {},
  isLoading: false
};

// Initialize state service using the Elm-inspired state machine
const counterService = service(counterBehavior);

// Subscribe to counter service state updates
counterService.subscribe((service) => {
  // Update our global state from the service state
  state.counter = service.state.counter;
  state.messages = service.state.messages;
  
  console.error("Counter state updated:", {
    counter: state.counter,
    messages: state.messages.length
  });
});

// Create the MCP server
const server = new Server(
  {
    name: "simple-echo-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {
        read: ["state://current"],
      },
      tools: {
        echo: {},
        increment: {},
        fetch: {},
      },
    },
  },
);

// Simple resources handler
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  console.error("Handling ListResourcesRequest");
  return {
    resources: [
      {
        uri: "state://current",
        mimeType: "application/json",
        name: "Current State",
      },
    ],
  };
});

// Simple resource reader
server.setRequestHandler(
  ReadResourceRequestSchema,
  async (request: ReadResourceRequest) => {
    const uri = request.params.uri;
    console.error(`Handling ReadResourceRequest for ${uri}`);

    if (uri === "state://current") {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  },
);

// Simple tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error("Handling ListToolsRequest");
  return {
    tools: [echoTool, incrementTool, fetchTool],
  };
});

// Helper to create a cache key for fetch requests
function createCacheKey(url: string, method = "GET"): string {
  return `${method}-${url}`;
}

// Simple tool handler
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    console.error(`Tool call request: ${JSON.stringify(request)}`);
    
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    
    if (toolName === "echo") {
      const text = args.text as string;
      console.error(`Echo tool called with: ${text}`);
      
      // Use counter service to handle the echo command
      counterService.execute({
        type: "echo",
        message: text
      });
      
      // Add to messages in global state
      state.messages.push(text);
      
      // Return the correctly formatted response
      return {
        content: [{ type: "text", text: `Echo: ${text}` }],
        isError: false,
      };
    }
    
    if (toolName === "increment") {
      const amount = typeof args.amount === 'number' ? args.amount : 1;
      console.error(`Increment tool called with amount: ${amount}`);
      
      // Use counter service to handle the increment command
      for (let i = 0; i < amount; i++) {
        counterService.execute({
          type: "increment"
        });
      }
      
      // Return the updated counter
      return {
        content: [{ 
          type: "text", 
          text: `Counter incremented by ${amount}. New value: ${state.counter}` 
        }],
        isError: false,
      };
    }
    
    if (toolName === "fetch") {
      const url = args.url as string;
      const method = (args.method as string) || "GET";
      const headers = args.headers as Record<string, string> || {};
      const body = args.body;
      
      console.error(`Fetch tool called with URL: ${url}, method: ${method}`);
      
      // Create cache key
      const cacheKey = createCacheKey(url, method);
      
      // Check cache for recent responses (less than 5 minutes old)
      const cachedResponse = state.fetchCache[cacheKey];
      const now = Date.now();
      
      if (cachedResponse && (now - cachedResponse.timestamp < 5 * 60 * 1000)) {
        console.error(`Using cached response for ${url}`);
        
        // Add to history that we're using cached data
        state.fetchHistory.push({
          url,
          method,
          timestamp: now,
          status: "success",
          response: cachedResponse.data,
          fromCache: true
        });
        
        return {
          content: [{ 
            type: "text", 
            text: `Fetched (from cache): ${url}\n\n${JSON.stringify(cachedResponse.data, null, 2)}` 
          }],
          isError: false,
        };
      }
      
      // Add to history that we're starting a request
      state.fetchHistory.push({
        url,
        method,
        timestamp: now,
        status: "pending"
      });
      
      // Mark as loading
      state.isLoading = true;
      
      try {
        // Perform the fetch
        console.error(`Performing fetch to ${url}`);
        
        // Prepare options for fetch
        const options: RequestInit = {
          method,
          headers: headers || {},
        };
        
        if (body) {
          options.body = typeof body === "object" ? JSON.stringify(body) : String(body);
        }
        
        // Execute the fetch request
        const response = await fetch(url, options);
        
        // Try to parse as JSON, but fallback to text
        let data;
        const contentType = response.headers.get("content-type") || "";
        
        if (contentType.includes("application/json")) {
          data = await response.json();
        } else {
          data = await response.text();
        }
        
        // Update history and cache
        const lastIndex = state.fetchHistory.length - 1;
        if (lastIndex >= 0) {
          state.fetchHistory[lastIndex] = {
            ...state.fetchHistory[lastIndex],
            status: "success",
            response: data,
            statusCode: response.status
          };
        }
        
        // Update cache
        state.fetchCache[cacheKey] = {
          data,
          timestamp: now
        };
        
        // No longer loading
        state.isLoading = false;
        
        console.error(`Fetch successful for ${url}`);
        
        // Return the fetched data
        return {
          content: [{ 
            type: "text", 
            text: `Fetched: ${url}\n\n${JSON.stringify(data, null, 2)}` 
          }],
          isError: false,
        };
      } catch (error) {
        console.error(`Fetch error for ${url}: ${error.message || String(error)}`);
        
        // Update history with error
        const lastIndex = state.fetchHistory.length - 1;
        if (lastIndex >= 0) {
          state.fetchHistory[lastIndex] = {
            ...state.fetchHistory[lastIndex],
            status: "error",
            error: error.message || String(error)
          };
        }
        
        // No longer loading
        state.isLoading = false;
        
        // Return the error
        return {
          content: [{ 
            type: "text", 
            text: `Error fetching ${url}: ${error.message || String(error)}` 
          }],
          isError: true,
        };
      }
    }
    
    return {
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  },
);

// Add unhandled rejection handler for debugging
self.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled Rejection:", event.reason);
});

try {
  // Create a transport
  console.error("Creating StdioServerTransport");
  const transport = new StdioServerTransport();
  
  // Connect to the transport
  console.error("Connecting to transport");
  await server.connect(transport);
  
  console.error("Server connected and running!");
} catch (error) {
  console.error("Failed to connect server:", error);
  Deno.exit(1);
}
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
} from "@modelcontextprotocol/sdk/types.js";

import { behavior as counterBehavior, CommandRegistry as CounterRegistry, Command as CounterCommand } from "./counter.ts";
import { behavior as fetcherBehavior, CommandRegistry as FetcherRegistry, Command as FetcherCommand } from "./fetcher.ts";
import { service } from "./state-machine.ts";
import { createToolsFromRegistry, waitForCompletion } from "./behavior-utils.ts";

// Create the state machine services
const counterService = service(counterBehavior);
const fetcherService = service(fetcherBehavior);

// Combine all tools from different registries
const combinedRegistry = {
  ...CounterRegistry,
  ...FetcherRegistry,
};

// Create tools from the combined registry
const tools = createToolsFromRegistry(combinedRegistry);

// Initialize MCP server
const server = new Server(
  {
    name: "behavior-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {
        read: ["state://counter", "state://fetcher"],
      },
      tools: Object.fromEntries(tools.map(tool => [tool.name, {}])),
    },
  },
);

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  console.error("Handling ListResourcesRequest");
  return {
    resources: [
      {
        uri: "state://counter",
        mimeType: "application/json",
        name: "Counter State",
      },
      {
        uri: "state://fetcher",
        mimeType: "application/json",
        name: "Fetcher State",
      },
    ],
  };
});

// Read state resources
server.setRequestHandler(
  ReadResourceRequestSchema,
  async (request: ReadResourceRequest) => {
    const uri = request.params.uri;
    console.error(`Handling ReadResourceRequest for ${uri}`);

    if (uri === "state://counter") {
      // Initialize the state machine if not already initialized
      if (!counterService.state) {
        counterService.advance(counterService.behavior.init());
      }
      
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(counterService.state, null, 2),
          },
        ],
      };
    } else if (uri === "state://fetcher") {
      // Initialize the state machine if not already initialized
      if (!fetcherService.state) {
        fetcherService.advance(fetcherService.behavior.init());
      }
      
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(fetcherService.state, null, 2),
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  },
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error("Handling ListToolsRequest");
  return { tools };
});

// Handle tool calls
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    
    console.error(`Tool call received: ${toolName} with args:`, args);
    
    // Check if the tool exists in our registry
    if (!(toolName in combinedRegistry)) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }
    
    // Get the command definition
    const commandDef = combinedRegistry[toolName as keyof typeof combinedRegistry];
    
    // Handle counter commands
    if (toolName in CounterRegistry) {
      // Initialize the state machine if not already initialized
      if (!counterService.state) {
        counterService.advance(counterService.behavior.init());
      }
      
      // Save the pre-command state for comparison
      const prevState = { ...counterService.state };
      
      // Build the command payload
      const command = {
        type: toolName,
        ...args,
      } as CounterCommand;
      
      // Execute the command through the state machine
      counterService.execute(command);
      
      // Wait for command completion based on its wait conditions
      const result = await waitForCompletion(
        commandDef,
        counterService.state,
        prevState,
        toolName,
        args
      );
      
      return result;
    }
    
    // Handle fetcher commands 
    if (toolName in FetcherRegistry) {
      // Initialize the state machine if not already initialized
      if (!fetcherService.state) {
        fetcherService.advance(fetcherService.behavior.init());
      }
      
      // Save the pre-command state for comparison
      const prevState = { ...fetcherService.state };
      
      // Build the command payload - the fetch effect is handled inside the state machine
      const command = {
        type: toolName,
        ...args,
      } as FetcherCommand;
      
      // Execute the command through the state machine
      fetcherService.execute(command);
      
      // Wait for command completion based on its wait conditions
      const result = await waitForCompletion(
        commandDef,
        fetcherService.state,
        prevState,
        toolName,
        args
      );
      
      return result;
    }
    
    // Should never get here
    return {
      content: [{ type: "text", text: `Unknown command handling for: ${toolName}` }],
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
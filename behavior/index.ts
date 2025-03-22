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

// Initial state
const state = {
  counter: 0,
  messages: []
};

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
    tools: [echoTool, incrementTool],
  };
});

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
      
      // Add to messages
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
      
      // Increment the counter
      state.counter += amount;
      
      // Return the updated counter
      return {
        content: [{ 
          type: "text", 
          text: `Counter incremented by ${amount}. New value: ${state.counter}` 
        }],
        isError: false,
      };
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
// behavior-utils.ts - Unified utilities for the behavior pattern

import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Command metadata with wait conditions and parameter definitions
 * Provides strong typing for commands and tools
 */
export interface CommandDef<
  P extends Record<string, any> = Record<string, never>,
> {
  type: string;
  description: string;
  params: P;
  required?: Array<keyof P>;
  // Metadata for waiting for command completion
  wait?: {
    condition: (state: any, previousState: any) => boolean;
    timeout?: number;
    resultExtractor?: (state: any) => any;
    errorDetector?: (state: any) => { isError: boolean; message?: string };
  };
}

/**
 * Creates MCP tools from a command registry
 * This bridges the gap between the state machine pattern and MCP
 */
export function createToolsFromRegistry(registry: Record<string, CommandDef<any>>): Tool[] {
  return Object.entries(registry).map(([name, def]) => {
    // Create the tool's input schema properties based on the command's params
    const properties: Record<string, any> = {};
    const required: string[] = [];

    // Convert command params to JSON schema properties
    Object.entries(def.params || {}).forEach(([paramName, paramDef]) => {
      properties[paramName] = {
        type: (paramDef as any).type || "string",
        description: (paramDef as any).description || "",
      };
    });

    // Add required parameters if specified
    if (def.required) {
      def.required.forEach(req => {
        required.push(req as string);
      });
    }

    // Return a properly formatted MCP tool
    return {
      name,
      description: def.description,
      inputSchema: {
        type: "object",
        properties,
        required,
      },
    };
  });
}

/**
 * Creates a command factory to simplify command definition
 */
export function createCommandDef<T extends string, P extends Record<string, any>>(
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
): CommandDef<P> {
  return {
    type,
    description,
    params,
    required,
    wait,
  };
}

/**
 * Type utility to derive command types from registry
 */
export type CommandsFromRegistry<T extends Record<string, CommandDef<any>>> = {
  [K in keyof T]: { type: K } & {
    [P in keyof T[K]["params"]]?: unknown;
  };
}[keyof T];

/**
 * Creates a standardized result formatter for MCP tools
 */
export function formatToolResult(
  toolName: string, 
  state: any, 
  args: Record<string, any>, 
  isError = false,
  errorMessage?: string,
): any {
  if (isError) {
    return {
      content: [{ type: "text", text: errorMessage || `Error executing ${toolName}` }],
      isError: true,
    };
  }
  
  // Format the response based on the command type
  let responseText = `${toolName} executed successfully`;
  
  // Custom formatters for specific tools
  switch (toolName) {
    case "echo":
      if ("text" in args) {
        responseText = `${args.text}`;
      }
      break;
    case "increment":
      const amount = typeof args.amount === 'number' ? args.amount : 1;
      responseText = `Counter incremented by ${amount}. New value: ${state.counter}`;
      break;
    case "decrement":
      responseText = `Counter decremented. New value: ${state.counter}`;
      break;
    case "reset":
      responseText = `Counter reset to zero.`;
      break;
    case "fetch":
      if (state.history && state.history.length > 0) {
        const lastRequest = state.history[state.history.length - 1];
        if (lastRequest && lastRequest.response) {
          let responseData = lastRequest.response;
          // If it's an object, stringify it nicely 
          if (typeof responseData === 'object') {
            responseData = JSON.stringify(responseData, null, 2);
          }
          responseText = `Fetched: ${lastRequest.url}\n\n${responseData}`;
        } else {
          responseText = `Fetch completed for ${args.url}`;
        }
      }
      break;
    case "clearCache":
      responseText = "Cache cleared successfully";
      break;
    case "clearHistory":
      responseText = "History cleared successfully";
      break;
  }
  
  return {
    content: [{ type: "text", text: responseText }],
    isError: false,
  };
}

/**
 * Helper to wait for a command to complete based on wait conditions
 */
export async function waitForCompletion<T>(
  commandDef: CommandDef<any>,
  state: T,
  prevState: T,
  toolName: string,
  args: Record<string, any>,
): Promise<any> {
  if (!commandDef.wait) {
    return formatToolResult(toolName, state, args);
  }
  
  const { condition, timeout = 5000, resultExtractor, errorDetector } = commandDef.wait;
  const startTime = Date.now();
  
  // Poll until condition is met or timeout
  while (Date.now() - startTime < timeout) {
    // Check for errors if an error detector is provided
    if (errorDetector) {
      const errorCheck = errorDetector(state);
      if (errorCheck.isError) {
        return formatToolResult(toolName, state, args, true, errorCheck.message);
      }
    }
    
    // Check if the condition is satisfied
    if (condition(state, prevState)) {
      // Extract result if a result extractor is provided
      const result = resultExtractor ? resultExtractor(state) : state;
      return formatToolResult(toolName, state, args);
    }
    
    // Wait a bit before checking again
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  
  // Timeout occurred
  return formatToolResult(
    toolName, 
    state, 
    args, 
    true, 
    `Timeout waiting for ${toolName} to complete`
  );
}
import { CoreMessage, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { AttributeValue, trace } from "@opentelemetry/api";
import {
  type LLMMessage,
  type LLMRequest,
  type LLMTool,
  type LLMToolCallPart,
  type LLMToolResultPart,
  type LLMTextPart,
} from "@commontools/llm/types";
import { findModel } from "./models.ts";

import { provider as otelProvider } from "@/lib/otel.ts";

import env from "@/env.ts";
import type { JSONSchema } from "@commontools/api";

// Constants for JSON mode
const JSON_SYSTEM_PROMPTS = {
  DEFAULT:
    "Ensure the response is valid JSON. DO NOT include any other text or formatting.",
  CLAUDE:
    "You are a JSON generation assistant. Your task is to generate valid, properly formatted JSON according to the user's request. Follow these guidelines:\n\n1. Only output valid JSON - no other text, explanations, or markdown formatting\n2. Ensure all keys and string values are properly quoted with double quotes\n3. Maintain proper nesting and indentation\n4. Close all brackets and braces properly\n5. Use proper JSON syntax with commas between elements but not after the last element in arrays or objects\n\nYour entire response must be a single valid JSON object or array that could be directly parsed by JSON.parse().",
  GROQ:
    "You must respond with pure, correct JSON only - no text descriptions, no ```json code blocks, and no formatting outside of valid JSON. Your entire response should be a valid JSON object that can be parsed directly by JSON.parse() with no additional processing.",
};

// Core generation logic separated from HTTP handling
export interface GenerateTextParams extends LLMRequest {
  abortSignal?: AbortSignal;
  // Updated callback to receive complete data for caching
  onStreamComplete?: (result: {
    message: LLMMessage;
    messages: LLMMessage[];
    originalRequest: GenerateTextParams;
  }) => void;
}

export interface GenerateTextResult {
  message: LLMMessage;
  messages: LLMMessage[];
  stream?: ReadableStream;
  spanId?: string;
}

// Configure the model parameters for JSON mode based on provider
export function configureJsonMode(
  streamParams: Record<string, unknown>,
  modelName: string,
  messages: LLMMessage[],
  isStreaming: boolean,
): void {
  // Default to using the generic JSON mode
  streamParams.mode = "json";

  // Apply provider-specific configurations
  if (modelName?.startsWith("groq:")) {
    // Groq uses response_format parameter
    streamParams.response_format = { type: "json_object" };

    // Ensure it's also passed through providerOptions for the Vercel AI SDK
    streamParams.providerOptions = {
      ...(streamParams.providerOptions as object | undefined),
      groq: {
        response_format: { type: "json_object" },
      },
    };

    // Add a stronger system prompt for Groq to prevent markdown code blocks
    if (!streamParams.system) {
      streamParams.system = JSON_SYSTEM_PROMPTS.GROQ;
    } else {
      streamParams.system = streamParams.system + "\n\n" +
        JSON_SYSTEM_PROMPTS.GROQ;
    }

    // Remove standard mode parameter as Groq doesn't support it
    delete streamParams.mode;
  } else if (modelName?.startsWith("openai:")) {
    // OpenAI uses response_format parameter
    streamParams.response_format = { type: "json_object" };

    // Ensure it's also passed through providerOptions for the Vercel AI SDK
    streamParams.providerOptions = {
      ...(streamParams.providerOptions as object | undefined),
      openai: {
        response_format: { type: "json_object" },
      },
    };

    // Remove the mode parameter since OpenAI uses response_format instead
    delete streamParams.mode;
  } else if (modelName?.startsWith("anthropic:")) {
    // Update or set system prompt for Claude
    if (!streamParams.system) {
      streamParams.system = JSON_SYSTEM_PROMPTS.CLAUDE;
    } else {
      // Prepend the JSON assistant role and append the JSON-specific instructions
      streamParams.system = "You are a JSON generation assistant. " +
        streamParams.system +
        "\n\nImportant: Your response must be ONLY valid JSON - no other text, explanations, or markdown formatting. The output should be directly parseable by JSON.parse().";
    }

    // Use prefill for non-streaming responses to anchor the JSON structure
    if (
      !isStreaming && messages.length > 0 &&
      messages[messages.length - 1].role === "user"
    ) {
      streamParams.prefill = {
        text: "{\n",
      };
    }
  } else {
    // For other providers, set a standard system prompt if one isn't provided
    if (!streamParams.system) {
      streamParams.system = JSON_SYSTEM_PROMPTS.DEFAULT;
    } else {
      // Always append JSON instructions, even if the prompt already mentions JSON
      streamParams.system += "\n" + JSON_SYSTEM_PROMPTS.DEFAULT;
    }
  }
}

// Add a helper function to clean up JSON responses from markdown code blocks
export function cleanJsonResponse(text: string): string {
  // Check if the response is wrapped in markdown code blocks
  const jsonCodeBlockRegex = /```(json)?\s*\n([\s\S]*?)\n```/;
  const match = text.match(jsonCodeBlockRegex);

  if (match && match[2]) {
    // Return just the JSON content inside the code block
    return match[2].trim();
  }

  return text;
}

export async function generateText(
  params: GenerateTextParams,
): Promise<GenerateTextResult> {
  // Validate and configure model
  const modelConfig = findModel(params.model!);
  if (!modelConfig) {
    console.error("Unsupported model:", params.model);
    throw new Error(`Unsupported model: ${params.model}`);
  }

  // Groq models don't support streaming in JSON mode
  if (params.mode && params.stream && params.model?.startsWith("groq:")) {
    throw new Error("Groq models don't support streaming in JSON mode");
  }

  // Convert messages to Vercel AI SDK format
  // Handle the new content array format with tool calls and results
  const coreMessages = params.messages.map((message): CoreMessage | null => {
    // Handle user messages
    if (message.role === "user") {
      if (typeof message.content === "string") {
        return { role: "user", content: message.content };
      }
      // If content is an array, extract text parts
      if (Array.isArray(message.content)) {
        const textParts = message.content
          .filter((part): part is LLMTextPart => 
            typeof part === "object" && "type" in part && part.type === "text"
          )
          .map(part => part.text)
          .join("\n");
        return { role: "user", content: textParts || "" };
      }
    }
    
    // Handle assistant messages with content arrays
    if (message.role === "assistant") {
      // Handle string content
      if (typeof message.content === "string") {
        return { role: "assistant", content: message.content };
      }
      
      // Handle content array with tool calls
      if (Array.isArray(message.content)) {
        const parts: any[] = [];
        
        for (const contentPart of message.content) {
          if (contentPart.type === "text") {
            parts.push({ type: "text", text: (contentPart as LLMTextPart).text });
          } else if (contentPart.type === "tool-call") {
            const toolCall = contentPart as LLMToolCallPart;
            parts.push({
              type: "tool-call",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              args: toolCall.args,
            });
          }
        }
        
        return { role: "assistant", content: parts };
      }
      
      // Handle legacy format with toolCalls/toolResults (backward compatibility)
      if (message.toolCalls && message.toolCalls.length > 0) {
        const parts: any[] = [];
        if (message.content) {
          parts.push({ type: "text", text: String(message.content) });
        }
        for (const toolCall of message.toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
          });
        }
        return { role: "assistant", content: parts };
      }
      
      return { role: "assistant", content: String(message.content || "") };
    }
    
    // Handle tool messages
    if (message.role === "tool") {
      if (Array.isArray(message.content)) {
        const toolResults = message.content
          .filter((part): part is LLMToolResultPart =>
            typeof part === "object" && "type" in part && part.type === "tool-result"
          );
        
        if (toolResults.length > 0) {
          const toolResult = toolResults[0]; // Vercel AI SDK expects one result per message
          return {
            role: "tool",
            content: [{
              type: "tool-result",
              toolCallId: toolResult.toolCallId,
              toolName: toolResult.toolName,
              result: toolResult.error ? { error: toolResult.error } : toolResult.result,
            } as any], // Cast to any due to SDK v5 type differences
          } as CoreMessage;
        }
      }
    }
    
    // Filter out unhandled message types
    return null;
  }).filter((msg): msg is CoreMessage => msg !== null);

  const streamParams: Parameters<typeof streamText>[0] = {
    model: modelConfig.model || params.model,
    messages: coreMessages,
    system: params.system,
    stopSequences: params.stop ? [params.stop] : undefined,
    abortSignal: params.abortSignal,
    experimental_telemetry: { isEnabled: true },
    maxOutputTokens: params.maxTokens,
    stopWhen: stepCountIs(8), // TODO(bf): low limit to prevent runaway process
  };

  // Convert client-side tools to AI SDK format (without execute functions for client-side execution)
  if (params.tools && Object.keys(params.tools).length > 0) {
    const aiSdkTools: Record<string, any> = {};

    for (const [name, toolDef] of Object.entries(params.tools)) {
      aiSdkTools[name] = tool({
        description: toolDef.description,
        inputSchema: jsonSchema(toolDef.inputSchema),
        // NO execute function - this makes it client-side execution
      });
    }

    (streamParams as any).tools = aiSdkTools;
  }

  // remove stopSequences if the model doesn't support them
  if (!modelConfig.capabilities.stopSequences) {
    streamParams.stopSequences = undefined;
  }

  // Apply JSON mode configuration if requested
  if (params.mode) {
    configureJsonMode(
      streamParams,
      params.model,
      params.messages,
      params.stream || false,
    );
  }

  // Handle models that don't support system prompts
  if (
    !modelConfig.capabilities.systemPrompt && params.system &&
    coreMessages.length > 0
  ) {
    coreMessages[0].content = `${params.system}\n\n${coreMessages[0].content}`;
    streamParams.system = undefined;
  }

  // Add model-specific configuration
  if (modelConfig.model) {
    streamParams.model = modelConfig.model;
  }

  streamParams.experimental_telemetry = {
    isEnabled: true,
    metadata: params.metadata
      ? Object.keys(params.metadata).reduce((out, prop) => {
        const value = params.metadata![prop];
        // Only overlap between LLMRequestMetadata values
        // and AttributeValue are string-type values.
        if (typeof value !== "string") return out;
        out[prop] = value;
        return out;
      }, {} as Record<string, AttributeValue>)
      : undefined,
    tracer: otelProvider.getTracer(env.OTEL_SERVICE_NAME || "toolshed-dev"),
  };

  // This is where the LLM API call is made
  const llmStream = await streamText(streamParams);

  // Get the active span from OpenTelemetry and set attributes
  const activeSpan = trace.getActiveSpan();
  const spanId = activeSpan?.spanContext().spanId;

  // Attach metadata directly to the root span
  if (activeSpan) {
    // Add the metadata from params if available
    if (params.metadata) {
      Object.entries(params.metadata).forEach(([key, value]) => {
        // Only set attributes with valid values (not undefined)
        if (value !== undefined) {
          // Handle different types to ensure we only use valid AttributeValue types
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            activeSpan.setAttribute(`metadata.${key}`, value);
          } else if (typeof value === "object") {
            // Convert objects to JSON strings
            activeSpan.setAttribute(`metadata.${key}`, JSON.stringify(value));
          }
        }
      });
    }
  }

  // If not streaming, handle regular response
  if (!params.stream) {
    let result = "";
    for await (const delta of llmStream.textStream) {
      result += delta;
    }

    if (!result) {
      throw new Error("No response from LLM");
    }

    // Clean up JSON responses when mode is enabled
    if (params.mode) {
      result = cleanJsonResponse(result);
    }

    // Only add stop token if not in JSON mode to avoid breaking JSON structure
    if (
      (await llmStream.finishReason) === "stop" && params.stop &&
      !params.mode
    ) {
      result += params.stop;
    }

    // Create the assistant response message
    const assistantMessage: LLMMessage = {
      role: "assistant",
      content: result,
    };

    return {
      message: assistantMessage,
      messages: [...params.messages, assistantMessage],
      spanId,
    };
  }

  // Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      let result = "";
      // If last message was from assistant, send it first
      if (params.messages.length > 0 && params.messages[params.messages.length - 1].role === "assistant") {
        const lastMessage = params.messages[params.messages.length - 1];
        const content = lastMessage.content;
        // This `content` could be a `LLMTypedContent`, which isn't supported here.
        if (typeof content !== "string") {
          throw new Error("LLMTypedContent not supported in responses.");
        }
        result = content;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(result) + "\n"),
        );
      }

      // Stream each event from the full AI SDK stream
      for await (const part of llmStream.fullStream) {
        if (part.type === "text-delta") {
          result += part.text;
          // Send text delta event to client
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                type: "text-delta",
                textDelta: part.text,
              }) + "\n",
            ),
          );
        } else if (part.type === "tool-call") {
          // Send tool call event to client
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                args: part.input,
              }) + "\n",
            ),
          );
        } else if (part.type === "tool-result") {
          // Send tool result event to client
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                type: "tool-result",
                toolCallId: part.toolCallId,
                result: part.output,
              }) + "\n",
            ),
          );
        }
      }

      // Only add stop token if not in JSON mode to avoid breaking JSON structure
      if (
        (await llmStream.finishReason) === "stop" && params.stop &&
        !params.mode
      ) {
        result += params.stop;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(params.stop) + "\n"),
        );
      }

      // For JSON mode, clean the result to strip any markdown code blocks
      if (params.mode) {
        result = cleanJsonResponse(result);
      }

      // Message history will be updated in onStreamComplete

      // Send finish event to client
      controller.enqueue(
        new TextEncoder().encode(
          JSON.stringify({
            type: "finish",
          }) + "\n",
        ),
      );

      // Create the assistant response message
      const assistantMessage: LLMMessage = {
        role: "assistant",
        content: result,
      };
      const finalMessages = [...params.messages, assistantMessage];

      // Call the onStreamComplete callback with all the data needed for caching
      if (params.onStreamComplete) {
        params.onStreamComplete({
          message: assistantMessage,
          messages: finalMessages,
          originalRequest: params,
        });
      }

      controller.close();
    },
  });

  // Create a placeholder assistant message for streaming response
  const assistantMessage: LLMMessage = {
    role: "assistant",
    content: "", // Will be filled by streaming
  };

  return {
    message: assistantMessage,
    messages: [...params.messages, assistantMessage],
    stream,
    spanId,
  };
}

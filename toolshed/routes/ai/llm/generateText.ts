import { streamText } from "ai";

import { findModel, TASK_MODELS } from "./models.ts";

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
export interface GenerateTextParams {
  model?: string;
  task?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  stream?: boolean;
  stop_token?: string;
  abortSignal?: AbortSignal;
  max_tokens?: number;
  mode?: "json";
  // Updated callback to receive complete data for caching
  onStreamComplete?: (result: {
    message: { role: "user" | "assistant"; content: string };
    messages: { role: "user" | "assistant"; content: string }[];
    originalRequest: GenerateTextParams;
  }) => void;
}

export interface GenerateTextResult {
  message: { role: "user" | "assistant"; content: string };
  messages: { role: "user" | "assistant"; content: string }[];
  stream?: ReadableStream;
}

// Configure the model parameters for JSON mode based on provider
export function configureJsonMode(
  streamParams: Record<string, any>,
  modelName: string,
  messages: { role: "user" | "assistant"; content: string }[],
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
      ...streamParams.providerOptions,
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
      ...streamParams.providerOptions,
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
  // Validate required model or task parameter
  if (!params.model && !params.task) {
    throw new Error("You must specify a `model` or `task`.");
  }

  let modelName = params.model;

  // If task specified, lookup corresponding model
  if (params.task) {
    const taskModel = TASK_MODELS[params.task as keyof typeof TASK_MODELS];
    if (!taskModel) {
      throw new Error(`Unsupported task: ${params.task}`);
    }
    modelName = taskModel;
  }

  // Validate and configure model
  const modelConfig = findModel(modelName!);
  if (!modelConfig) {
    console.error("Unsupported model:", modelName);
    throw new Error(`Unsupported model: ${modelName}`);
  }

  // Groq models don't support streaming in JSON mode
  if (params.mode && params.stream && modelName?.startsWith("groq:")) {
    throw new Error("Groq models don't support streaming in JSON mode");
  }

  const messages = params.messages;
  const streamParams: Record<string, any> = {
    model: modelConfig.model || modelName!,
    messages,
    stream: params.stream,
    system: params.system,
    stopSequences: params.stop_token ? [params.stop_token] : undefined,
    abortSignal: params.abortSignal,
    experimental_telemetry: { isEnabled: true },
    maxTokens: params.max_tokens,
  };

  // Apply JSON mode configuration if requested
  if (params.mode) {
    configureJsonMode(
      streamParams,
      modelName!,
      messages,
      params.stream || false,
    );
  }

  // Handle models that don't support system prompts
  if (
    !modelConfig.capabilities.systemPrompt && params.system &&
    messages.length > 0
  ) {
    messages[0].content = `${params.system}\n\n${messages[0].content}`;
    streamParams.system = undefined;
  }

  // Add model-specific configuration
  if (modelConfig.model) {
    streamParams.model = modelConfig.model;
  }

  const llmStream = await streamText(streamParams as any);

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
      (await llmStream.finishReason) === "stop" && params.stop_token &&
      !params.mode
    ) {
      result += params.stop_token;
    }

    if (messages[messages.length - 1].role === "user") {
      messages.push({ role: "assistant", content: result });
    } else {
      messages[messages.length - 1].content = result;
    }

    return {
      message: messages[messages.length - 1],
      messages: [...messages],
    };
  }

  // Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      let result = "";
      // If last message was from assistant, send it first
      if (messages[messages.length - 1].role === "assistant") {
        result = messages[messages.length - 1].content;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(result) + "\n"),
        );
      }

      // Stream each chunk of generated text
      for await (const delta of llmStream.textStream) {
        result += delta;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(delta) + "\n"),
        );
      }

      // Only add stop token if not in JSON mode to avoid breaking JSON structure
      if (
        (await llmStream.finishReason) === "stop" && params.stop_token &&
        !params.mode
      ) {
        result += params.stop_token;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(params.stop_token) + "\n"),
        );
      }

      // For JSON mode, clean the result to strip any markdown code blocks
      if (params.mode) {
        result = cleanJsonResponse(result);
      }

      // Update message history
      if (messages[messages.length - 1].role === "user") {
        messages.push({ role: "assistant", content: result });
      } else {
        messages[messages.length - 1].content = result;
      }

      // Call the onStreamComplete callback with all the data needed for caching
      if (params.onStreamComplete) {
        params.onStreamComplete({
          message: messages[messages.length - 1],
          messages: [...messages],
          originalRequest: params,
        });
      }

      controller.close();
    },
  });

  return {
    message: messages[messages.length - 1],
    messages: [...messages],
    stream,
  };
}

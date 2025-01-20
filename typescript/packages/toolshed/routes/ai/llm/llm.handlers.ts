import { streamText } from "npm:ai";
import { crypto } from "@std/crypto/crypto";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { GenerateTextRoute, GetModelsRoute } from "./llm.routes.ts";
import {
  ALIAS_NAMES,
  findModel,
  ModelList,
  MODELS,
  TASK_MODELS,
} from "./models.ts";
import * as cache from "./cache.ts";
import type { Context } from "hono";

/**
 * Handler for GET /models endpoint
 * Returns filtered list of available LLM models based on search criteria
 */
export const getModels: AppRouteHandler<GetModelsRoute> = (c) => {
  const { search, capability, task } = c.req.query();
  const capabilities = capability?.split(",");

  const modelInfo = Object.entries(MODELS).reduce(
    (acc, [name, modelConfig]) => {
      // Skip alias names, we only want primary model names
      if (!ALIAS_NAMES.includes(name)) {
        // Apply filters: name search, capabilities, and task matching
        const nameMatches = !search ||
          name.toLowerCase().includes(search.toLowerCase());
        const capabilitiesMatch = !capabilities ||
          capabilities.every(
            (cap) =>
              modelConfig.capabilities[
                cap as keyof typeof modelConfig.capabilities
              ],
          );
        const taskMatches = !task ||
          TASK_MODELS[task as keyof typeof TASK_MODELS] === name;

        // Include model if it passes all filters
        if (nameMatches && capabilitiesMatch && taskMatches) {
          acc[name] = {
            model: modelConfig.model,
            capabilities: modelConfig.capabilities,
            aliases: Object.entries(MODELS)
              .filter(([_, m]) => m === modelConfig && name !== _)
              .map(([alias]) => alias),
          };
        }
      }
      return acc;
    },
    {} as ModelList,
  );

  return c.json(modelInfo);
};

// Core generation logic separated from HTTP handling
export interface GenerateTextParams {
  model?: string;
  task?: string;
  messages: { role: string; content: string }[];
  system?: string;
  stream?: boolean;
  stop_token?: string;
  abortSignal?: AbortSignal;
}

export interface GenerateTextResult {
  message: { role: string; content: string };
  stream?: ReadableStream;
}

export async function generateTextCore(
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
  const modelConfig = findModel(modelName);
  if (!modelConfig) {
    console.error("Unsupported model:", modelName);
    throw new Error(`Unsupported model: ${modelName}`);
  }

  const messages = params.messages;
  const streamParams = {
    model: modelConfig.model || modelName,
    messages,
    stream: params.stream,
    system: params.system,
    stopSequences: params.stop_token ? [params.stop_token] : undefined,
    abortSignal: params.abortSignal,
    experimental_telemetry: { isEnabled: true },
  };

  // Handle models that don't support system prompts
  if (
    !modelConfig.capabilities.systemPrompt &&
    params.system &&
    messages.length > 0
  ) {
    messages[0].content = `${params.system}\n\n${messages[0].content}`;
    streamParams.system = undefined;
  }

  // Add model-specific configuration
  if (modelConfig.model) {
    streamParams.model = modelConfig.model;
  }

  const llmStream = await streamText(streamParams);

  // If not streaming, handle regular response
  if (!params.stream) {
    let result = "";
    for await (const delta of llmStream.textStream) {
      result += delta;
    }

    if (!result) {
      throw new Error("No response from LLM");
    }

    if ((await llmStream.finishReason) === "stop" && params.stop_token) {
      result += params.stop_token;
    }

    if (messages[messages.length - 1].role === "user") {
      messages.push({ role: "assistant", content: result });
    } else {
      messages[messages.length - 1].content = result;
    }

    return { message: messages[messages.length - 1] };
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

      // Add stop sequence if specified
      if ((await llmStream.finishReason) === "stop" && params.stop_token) {
        result += params.stop_token;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(params.stop_token) + "\n"),
        );
      }

      // Update message history
      if (messages[messages.length - 1].role === "user") {
        messages.push({ role: "assistant", content: result });
      } else {
        messages[messages.length - 1].content = result;
      }

      controller.close();
    },
  });

  return {
    message: messages[messages.length - 1],
    stream,
  };
}

/**
 * Handler for POST / endpoint
 * Generates text using specified LLM model or task
 */
export const generateText: AppRouteHandler<GenerateTextRoute> = async (c) => {
  const payload = await c.req.json();

  try {
    // Check cache for existing response
    const cacheKey = await cache.hashKey(JSON.stringify(payload));
    const cachedResult = await cache.loadItem(cacheKey);
    if (cachedResult) {
      const lastMessage =
        cachedResult.messages[cachedResult.messages.length - 1];
      return c.json(lastMessage);
    }

    const result = await generateTextCore({
      ...payload,
      abortSignal: c.req.raw.signal,
    });

    if (!payload.stream) {
      await cache.saveItem(cacheKey, {
        ...payload,
        messages: [...payload.messages, result.message],
      });
      return c.json(result.message);
    }

    return new Response(result.stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, HttpStatusCodes.BAD_REQUEST);
  }
};

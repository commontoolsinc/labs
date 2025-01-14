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
        const capabilitiesMatch = !capabilities || capabilities.every(
          (cap) =>
            modelConfig
              .capabilities[cap as keyof typeof modelConfig.capabilities],
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

/**
 * Handler for POST / endpoint
 * Generates text using specified LLM model or task
 */
export const generateText: AppRouteHandler<GenerateTextRoute> = async (c) => {
  const payload = await c.req.json();

  // Validate required model or task parameter
  if (!payload.model && !payload.task) {
    return c.json(
      { error: "You must specify a `model` or `task`." },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  // If task specified, lookup corresponding model
  if (payload.task) {
    const taskModel = TASK_MODELS[payload.task as keyof typeof TASK_MODELS];
    if (!taskModel) {
      return c.json({
        error: `Unsupported task: ${payload.task}`,
        availableTasks: Object.keys(TASK_MODELS),
      }, HttpStatusCodes.BAD_REQUEST);
    }
    payload.model = taskModel;
  }

  // Check cache for existing response
  const cacheKey = await cache.hashKey(JSON.stringify(payload));
  const cachedResult = await cache.loadItem(cacheKey);
  if (cachedResult) {
    const lastMessage = cachedResult.messages[cachedResult.messages.length - 1];
    return c.json(lastMessage);
  }

  // Validate and configure model
  const modelConfig = findModel(payload.model);
  if (!modelConfig) {
    return c.json({
      error: `Unsupported model: ${payload.model}`,
      availableModels: Object.keys(MODELS),
    }, HttpStatusCodes.BAD_REQUEST);
  }

  const messages = payload.messages;
  const params = {
    model: modelConfig.model || payload.model,
    messages,
    stream: payload.stream,
    system: payload.system,
    stopSequences: payload.stop_token ? [payload.stop_token] : undefined,
    abortSignal: c.req.raw.signal,
    experimental_telemetry: { isEnabled: true },
  };

  // Handle models that don't support system prompts
  if (
    !modelConfig.capabilities.systemPrompt && payload.system &&
    messages.length > 0
  ) {
    messages[0].content = `${payload.system}\n\n${messages[0].content}`;
    params.system = undefined;
  }

  // Add model-specific configuration
  if (modelConfig.model) {
    params.model = modelConfig.model;
  }

  const llmStream = await streamText(params);

  // If not streaming, handle regular response
  if (!payload.stream) {
    let result = "";
    for await (const delta of llmStream.textStream) {
      result += delta;
    }

    if (!result) {
      return c.json(
        { error: "No response from LLM" },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    if ((await llmStream.finishReason) === "stop" && payload.stop_token) {
      result += payload.stop_token;
    }

    if (messages[messages.length - 1].role === "user") {
      messages.push({ role: "assistant", content: result });
    } else {
      messages[messages.length - 1].content = result;
    }

    await cache.saveItem(cacheKey, params);
    return c.json(messages[messages.length - 1]);
  }

  // Return streamed response
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
      if ((await llmStream.finishReason) === "stop" && payload.stop_token) {
        result += payload.stop_token;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(payload.stop_token) + "\n"),
        );
      }

      // Update message history
      if (messages[messages.length - 1].role === "user") {
        messages.push({ role: "assistant", content: result });
      } else {
        messages[messages.length - 1].content = result;
      }

      // await cache.saveItem(cacheKey, params);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
};

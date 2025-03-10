import * as HttpStatusCodes from "stoker/http-status-codes";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { GenerateTextRoute, GetModelsRoute } from "./llm.routes.ts";
import { ALIAS_NAMES, ModelList, MODELS, TASK_MODELS } from "./models.ts";
import * as cache from "./cache.ts";
import type { Context } from "@hono/hono";
import { generateText as generateTextCore } from "./generateText.ts";
import { findModel } from "./models.ts";
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

  const modelString = payload.model;
  const model = modelString ? findModel(modelString) : null;
  const modelDefaultMaxTokens = model?.capabilities.maxOutputTokens || 8000;
  if (!model) {
    return c.json({ error: "Invalid model" }, HttpStatusCodes.BAD_REQUEST);
  }

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
      max_tokens: payload.max_tokens || modelDefaultMaxTokens,
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
    console.error("Error in generateText:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, HttpStatusCodes.BAD_REQUEST);
  }
};

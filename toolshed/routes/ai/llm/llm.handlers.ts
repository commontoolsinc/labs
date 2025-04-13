import * as HttpStatusCodes from "stoker/http-status-codes";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { GenerateTextRoute, GetModelsRoute } from "./llm.routes.ts";
import { ALIAS_NAMES, ModelList, MODELS, TASK_MODELS } from "./models.ts";
import * as cache from "./cache.ts";
import type { Context } from "@hono/hono";
import { generateText as generateTextCore } from "./generateText.ts";
import { findModel } from "./models.ts";

const withoutMetadata = (obj: any) => {
  const { metadata, ...rest } = obj;
  return rest;
};

/**
 * Validates that the model and JSON mode settings are compatible
 * @returns An error response object if validation fails, or null if validation passes
 */
function validateModelAndJsonMode(
  c: Context,
  modelString: string | undefined,
  mode: string | undefined,
) {
  const model = modelString ? findModel(modelString) : null;

  if (!model) {
    return c.json({ error: "Invalid model" }, HttpStatusCodes.BAD_REQUEST);
  }

  // Validate JSON mode support if requested
  const isJsonMode = mode === "json";

  // Groq models don't support streaming with JSON mode
  if (
    isJsonMode && c.req.query("stream") === "true" &&
    modelString?.startsWith("groq:")
  ) {
    return c.json(
      {
        error:
          "Groq models don't support streaming in JSON mode. Please set stream to false.",
      },
      HttpStatusCodes.BAD_REQUEST,
    );
  }

  return null;
}

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
            name,
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
  if (!payload.metadata) {
    payload.metadata = {};
  }

  payload.metadata.json_mode = payload.mode === "json";

  const user = c.req.header("Tailscale-User-Login");
  if (user) {
    payload.metadata.user = user;
  }

  // First, check whether the request is cached, if so return the cached result
  const cacheKey = await cache.hashKey(
    JSON.stringify(withoutMetadata(payload)),
  );
  const cachedResult = await cache.loadItem(cacheKey);
  if (cachedResult) {
    const lastMessage = cachedResult.messages[cachedResult.messages.length - 1];
    return c.json(lastMessage);
  }

  const persistCache = async (
    messages: { role: string; content: string }[],
  ) => {
    try {
      await cache.saveItem(cacheKey, {
        ...withoutMetadata(payload),
        messages,
      });
    } catch (e) {
      console.error("Error saving response to cache:", e);
    }
  };

  const validationError = validateModelAndJsonMode(
    c,
    payload.model,
    payload.mode,
  );
  if (validationError) {
    return validationError;
  }

  const model = findModel(payload.model);
  payload.metadata.model = model.name;
  const modelDefaultMaxTokens = model?.capabilities.maxOutputTokens || 8000;

  try {
    const result = await generateTextCore({
      ...payload,
      abortSignal: c.req.raw.signal,
      max_tokens: payload.max_tokens || modelDefaultMaxTokens,
      // If response is streaming, save to cache after the stream is complete
      onStreamComplete: payload.stream
        ? async (result) => {
          await persistCache(result.messages);
        }
        : undefined,
    });

    // If response is not streaming, save to cache and return the message
    if (!payload.stream) {
      await persistCache(result.messages);
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

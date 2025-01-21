import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { Schema, SchemaDefinition, Validator } from "jsonschema";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { ProcessSchemaRoute, SearchSchemaRoute } from "./spell.routes.ts";
import { performSearch } from "@/lib/behavior/search.ts";
import { generateText } from "@/lib/llm/generateText.ts";
import { getAllBlobs } from "@/lib/redis/redis.ts";
import { storage } from "@/storage.ts";

// Process Schema schemas
export const ProcessSchemaRequestSchema = z.object({
  schema: z.record(
    z
      .string()
      .or(
        z.number().or(z.boolean().or(z.array(z.any()).or(z.record(z.any())))),
      ),
  ),
  many: z.boolean().optional(),
  prompt: z.string().optional(),
  options: z
    .object({
      format: z.enum(["json", "yaml"]).optional(),
      validate: z.boolean().optional(),
      maxExamples: z.number().default(5).optional(),
    })
    .optional(),
});

export const ProcessSchemaResponseSchema = z.object({
  result: z.union([z.record(z.any()), z.array(z.record(z.any()))]),
  metadata: z.object({
    processingTime: z.number(),
    schemaFormat: z.string(),
    examples: z.array(
      z.object({
        key: z.string(),
        data: z.record(z.any()),
      }),
    ),
  }),
});

export type ProcessSchemaRequest = z.infer<typeof ProcessSchemaRequestSchema>;
export type ProcessSchemaResponse = z.infer<typeof ProcessSchemaResponseSchema>;

export const SearchSchemaRequestSchema = z.object({
  query: z.string(),
  options: z
    .object({
      limit: z.number().optional().default(10),
      offset: z.number().optional().default(0),
    })
    .optional(),
});

export const SearchSchemaResponseSchema = z.object({
  results: z.array(
    z.object({
      source: z.string(),
      results: z.array(
        z.object({
          key: z.string(),
          data: z.record(z.any()),
        }),
      ),
    }),
  ),
  metadata: z.object({
    total: z.number(),
    processingTime: z.number(),
  }),
});

export type SearchSchemaRequest = z.infer<typeof SearchSchemaRequestSchema>;
export type SearchSchemaResponse = z.infer<typeof SearchSchemaResponseSchema>;

export const imagine: AppRouteHandler<ProcessSchemaRoute> = async c => {
  const redis = c.get("blobbyRedis");
  if (!redis) throw new Error("Redis client not found in context");
  const logger = c.get("logger");

  const body = (await c.req.json()) as ProcessSchemaRequest;
  const startTime = performance.now();

  try {
    logger.info(
      { schema: body.schema, many: body.many },
      "Processing schema request",
    );

    const allBlobs = await getAllBlobs(redis);
    const matchingExamples: Array<{
      key: string;
      data: Record<string, unknown>;
    }> = [];
    const allExamples: Array<{
      key: string;
      data: Record<string, unknown>;
    }> = [];

    for (const blobKey of allBlobs) {
      try {
        const content = await storage.getBlob(blobKey);
        if (!content) continue;

        const blobData = JSON.parse(content);

        allExamples.push({
          key: blobKey,
          data: blobData,
        });

        const matches = checkSchemaMatch(blobData, body.schema);
        if (matches) {
          matchingExamples.push({
            key: blobKey,
            data: blobData,
          });
        }
      } catch (error) {
        continue;
      }
    }

    const maxExamples = body.options?.maxExamples || 5;

    const examplesList =
      matchingExamples.length > 0
        ? matchingExamples.slice(0, maxExamples)
        : allExamples.sort(() => Math.random() - 0.5).slice(0, maxExamples);

    const prompt = constructSchemaPrompt(
      body.schema,
      examplesList,
      body.prompt,
      body.many,
    );

    const llmResponse = await generateText({
      model: "claude-3-5-sonnet",
      system: body.many
        ? "Generate valid JSON array containing multiple objects, no commentary. Each object in the array must fulfill the schema exactly, if there is no reference data then return nothing."
        : "Generate valid JSON only, no commentary. The schema provided must be fulfilled exactly, if there is no reference data return nothing.",
      stream: false,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    let result: Record<string, unknown> | Array<Record<string, unknown>>;
    try {
      result = JSON.parse(llmResponse.message.content);
      // Validate that we got an array when many=true
      if (body.many && !Array.isArray(result)) {
        result = [result]; // Wrap single object in array if needed
      }
    } catch (error) {
      logger.error({ error }, "Failed to parse LLM response");
      throw new Error("Failed to parse LLM response as JSON");
    }

    const response: ProcessSchemaResponse = {
      result,
      metadata: {
        processingTime: Math.round(performance.now() - startTime),
        schemaFormat: body.options?.format || "json",
        examples: examplesList,
      },
    };

    logger.info(
      { processingTime: response.metadata.processingTime },
      "Request completed",
    );
    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing schema");
    return c.json(
      { error: "Failed to process schema" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

function checkSchemaMatch(
  data: Record<string, unknown>,
  schema: Schema,
): boolean {
  const validator = new Validator();

  const jsonSchema: SchemaDefinition = {
    type: "object",
    properties: Object.keys(schema).reduce(
      (acc: Record<string, SchemaDefinition>, key) => {
        acc[key] = { type: schema[key].type || typeof schema[key] };
        return acc;
      },
      {},
    ),
    required: Object.keys(schema),
    additionalProperties: true,
  };

  const rootResult = validator.validate(data, jsonSchema);
  if (rootResult.valid) {
    return true;
  }

  function checkSubtrees(obj: unknown): boolean {
    if (typeof obj !== "object" || obj === null) {
      return false;
    }

    if (Array.isArray(obj)) {
      return obj.some(item => checkSubtrees(item));
    }

    const result = validator.validate(obj, jsonSchema);
    if (result.valid) {
      return true;
    }

    return Object.values(obj).some(value => checkSubtrees(value));
  }

  return checkSubtrees(data);
}

function constructSchemaPrompt(
  schema: Record<string, unknown>,
  examples: Array<{ key: string; data: Record<string, unknown> }>,
  userPrompt?: string,
  many?: boolean,
): string {
  const schemaStr = JSON.stringify(schema, null, 2);
  const MAX_VALUE_LENGTH = 500; // Maximum length for individual values

  // Helper function to truncate large values
  function sanitizeObject(
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        // Truncate long strings
        if (value.length > MAX_VALUE_LENGTH) {
          sanitized[key] =
            value.substring(0, MAX_VALUE_LENGTH) + "... [truncated]";
          continue;
        }
      } else if (typeof value === "object" && value !== null) {
        // Handle arrays and objects
        const stringified = JSON.stringify(value);
        if (stringified.length > MAX_VALUE_LENGTH) {
          sanitized[key] = "[large content omitted]";
          continue;
        }
      }
      sanitized[key] = value;
    }
    return sanitized;
  }

  const examplesStr = examples
    .map(({ key, data }) => {
      const sanitizedData = sanitizeObject(data);
      return `--- Example from "${key}" ---\n${JSON.stringify(
        sanitizedData,
        null,
        2,
      )}`;
    })
    .join("\n\n");

  return `# TASK
  ${
    many
      ? `Generate multiple objects that fit the requested schema based on the references provided.`
      : `Fit data into the requested schema based on the references provided.`
  }

# SCHEMA
${schemaStr}

# REFERENCES FROM DATABASE
${examples.length > 0 ? examplesStr : "No existing examples found in database."}

# INSTRUCTIONS
1. ${
    many
      ? `Generate an array of objects that strictly follow the schema structure`
      : `Generate an object that strictly follows the schema structure`
  }
2. Combine and synthesize examples to create valid ${
    many ? "objects" : "an object"
  }
3. Return ONLY valid JSON ${many ? "array" : "object"} matching the schema

${userPrompt ? `# ADDITIONAL REQUIREMENTS\n${userPrompt}\n\n` : ""}

# RESPONSE FORMAT
Respond with ${
    many ? "an array of valid JSON objects" : "a single valid JSON object"
  }.`;
}

export const search: AppRouteHandler<SearchSchemaRoute> = async c => {
  const redis = c.get("blobbyRedis");
  if (!redis) throw new Error("Redis client not found in context");
  const logger = c.get("logger");

  const startTime = performance.now();
  const body = (await c.req.json()) as SearchSchemaRequest;

  try {
    logger.info({ query: body.query }, "Processing search request");

    const result = await performSearch(body.query, logger, redis);

    const response = result;

    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing search");
    return c.json(
      { error: "Failed to process search" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

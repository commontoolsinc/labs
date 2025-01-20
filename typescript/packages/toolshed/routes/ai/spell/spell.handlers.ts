import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { Validator } from "jsonschema";

import type { AppRouteHandler } from "@/lib/types.ts";
import type { ProcessSchemaRoute } from "./spell.routes.ts";
import { generateTextCore } from "../llm/llm.handlers.ts";
import { getAllBlobs } from "../../storage/blobby/lib/redis.ts";
import { storage } from "../../storage/blobby/blobby.handlers.ts";

// Process Schema schemas
export const ProcessSchemaRequestSchema = z.object({
  schema: z.record(
    z
      .string()
      .or(
        z.number().or(z.boolean().or(z.array(z.any()).or(z.record(z.any())))),
      ),
  ),
  prompt: z.string().optional(), // Add optional prompt field
  options: z
    .object({
      format: z.enum(["json", "yaml"]).optional(),
      validate: z.boolean().optional(),
      maxExamples: z.number().optional(), // Add optional maxExamples field
    })
    .optional(),
});

export const ProcessSchemaResponseSchema = z.object({
  result: z.record(z.any()),
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

export const imagine: AppRouteHandler<ProcessSchemaRoute> = async (c) => {
  const redis = c.get("blobbyRedis");
  if (!redis) throw new Error("Redis client not found in context");
  const logger = c.get("logger");

  const body = (await c.req.json()) as ProcessSchemaRequest;
  const startTime = performance.now();

  try {
    logger.info({ schema: body.schema }, "Processing schema request");

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

    const examplesList = matchingExamples.length > 0
      ? matchingExamples
      : allExamples.sort(() => Math.random() - 0.5).slice(0, 5);

    const prompt = constructSchemaPrompt(
      body.schema,
      examplesList,
      body.prompt,
    );

    const llmResponse = await generateTextCore({
      model: "claude-3-5-sonnet",
      system:
        "Generate valid JSON only, no commentary. The schema provided must be fulfilled exactly, if there is no reference data to draw from then make it up (with a meta property explaining it is hallucinated).",
      stream: false,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(llmResponse.message.content);
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

function checkSchemaMatch(data: Record<string, unknown>, schema: any): boolean {
  const validator = new Validator();

  const jsonSchema = {
    type: "object",
    properties: Object.keys(schema).reduce((acc: Record<string, any>, key) => {
      acc[key] = { type: schema[key].type || typeof schema[key] };
      return acc;
    }, {}),
    required: Object.keys(schema),
    additionalProperties: true,
  };

  const rootResult = validator.validate(data, jsonSchema);
  if (rootResult.valid) {
    return true;
  }

  function checkSubtrees(obj: any): boolean {
    if (typeof obj !== "object" || obj === null) {
      return false;
    }

    if (Array.isArray(obj)) {
      return obj.some((item) => checkSubtrees(item));
    }

    const result = validator.validate(obj, jsonSchema);
    if (result.valid) {
      return true;
    }

    return Object.values(obj).some((value) => checkSubtrees(value));
  }

  return checkSubtrees(data);
}

function constructSchemaPrompt(
  schema: Record<string, unknown>,
  examples: Array<{ key: string; data: Record<string, unknown> }>,
  userPrompt?: string,
): string {
  const schemaStr = JSON.stringify(schema, null, 2);
  const maxExamples = 5;

  const examplesStr = examples
    .slice(0, maxExamples)
    .map(({ key, data }) => {
      return `--- Example from "${key}" ---\n${JSON.stringify(data, null, 2)}`;
    })
    .join("\n\n");

  const shuffledExamples = [...examples].sort(() => Math.random() - 0.5);
  examples = shuffledExamples.slice(0, maxExamples);

  return `# TASK
Generate a new object that precisely matches the provided schema.

# SCHEMA
${schemaStr}

# REFERENCE EXAMPLES
${examples.length > 0 ? examplesStr : "No existing examples found in database."}

# INSTRUCTIONS
1. Generate an object that strictly follows the schema structure
2. Use context from examples where relevant
3. If no relevant context exists, create appropriate fictional data
4. Include a "_meta" property if data is fabricated
5. Return ONLY valid JSON matching the schema

${userPrompt ? `# ADDITIONAL REQUIREMENTS\n${userPrompt}\n\n` : ""}

# RESPONSE FORMAT
Respond with a single valid JSON object.`;
}

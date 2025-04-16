import { generateText } from "@/lib/llm.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import { extractJSON } from "@/routes/ai/spell/json.ts";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { captureException } from "@sentry/deno";
import type { AppRouteHandler } from "@/lib/types.ts";
import type { ImagineDataRoute } from "@/routes/ai/spell/spell.routes.ts";

export const ImagineDataRequestSchema = z.object({
  schema: z.record(
    z
      .string()
      .or(
        z.number().or(z.boolean().or(z.array(z.any()).or(z.record(z.any())))),
      ),
  )
    .describe("JSON schema format to conform to")
    .openapi({
      example: {
        title: { type: "string" },
        url: { type: "string" },
      },
    }),
  model: z.string().default("google:gemini-2.0-flash").describe(
    "The LLM to use for data generation",
  ).openapi({ example: "claude-3-7-sonnet" }),
  prompt: z.string().optional().describe(
    "Guide data generation with a prompt",
  ).openapi({ example: "Make it about cats" }),
  options: z
    .object({
      many: z.boolean().default(false).describe(
        "Whether to generate multiple results",
      ),
    })
    .optional(),
});

export const ImagineDataResponseSchema = z.object({
  result: z.union([z.record(z.any()), z.array(z.record(z.any()))]),
  metadata: z.object({
    processingTime: z.number(),
  }),
});

export type ImagineDataRequest = z.infer<typeof ImagineDataRequestSchema>;
export type ImagineDataResponse = z.infer<typeof ImagineDataResponseSchema>;

export async function processSchema(
  body: ImagineDataRequest,
  logger: Logger,
  startTime: number,
): Promise<ImagineDataResponse> {
  logger.info(
    { schema: body.schema, options: body.options },
    "Starting schema processing request",
  );

  logger.debug("Constructing prompt with reassembled examples");
  const prompt = constructSchemaPrompt(
    body.schema,
    body.prompt,
    body?.options?.many,
  );

  logger.info({ prompt }, "Sending request to LLM");
  const llmStartTime = performance.now();
  const llmResponse = await generateText({
    model: "claude-3-7-sonnet",
    system: body?.options?.many
      ? "Generate realistic example data that fits the provided schema. Return valid JSON array with multiple objects. Each object must match the schema exactly and respect all descriptions and constraints."
      : "Generate realistic example data that fits the provided schema. Return a valid JSON object that matches the schema exactly and respects all descriptions and constraints.",
    stream: false,
    messages: [{ role: "user", content: prompt }],
    cache: true,
  });
  logger.info(
    { llmTime: Math.round(performance.now() - llmStartTime) },
    "Received LLM response",
  );

  let result: Record<string, unknown> | Array<Record<string, unknown>>;

  try {
    logger.debug("Parsing LLM response");
    if (typeof llmResponse !== "string") {
      throw new Error("Received unsupported LLM typed content.");
    }
    result = extractJSON(llmResponse);
    logger.debug({ extractedJSON: result }, "Extracted JSON from response");

    if (body?.options?.many && !Array.isArray(result)) {
      logger.debug("Converting single object to array for many=true");
      result = [result];
    }
    logger.info(
      {
        resultType: body?.options?.many ? "array" : "object",
        resultSize: body?.options?.many ? (result as Array<unknown>).length : 1,
      },
      "Successfully parsed LLM response",
    );
  } catch (error) {
    logger.error(
      { error, response: llmResponse },
      "Failed to parse LLM response",
    );
    throw new Error("Failed to parse LLM response as JSON");
  }

  const totalTime = Math.round(performance.now() - startTime);
  logger.info(
    { totalTime },
    "Completed schema processing request",
  );

  return {
    result,
    metadata: {
      processingTime: totalTime,
    },
  };
}

function constructSchemaPrompt(
  schema: Record<string, unknown>,
  userPrompt?: string,
  many?: boolean,
): string {
  const schemaStr = JSON.stringify(schema, null, 2);

  return `# TASK
  ${
    many
      ? `Generate multiple objects that fit the requested schema based on the references provided.`
      : `Fit data into the requested schema based on the references provided.`
  }

# SCHEMA
${schemaStr}

# INSTRUCTIONS
1. ${
    many
      ? `Generate an array of objects that strictly follow the schema structure`
      : `Generate an object that strictly follows the schema structure`
  }
2. Return ONLY valid JSON ${many ? "array" : "object"} matching the schema

${userPrompt ? `# ADDITIONAL REQUIREMENTS\n${userPrompt}\n\n` : ""}

# RESPONSE FORMAT
Respond with ${
    many ? "an array of valid JSON objects" : "a single valid JSON object"
  }.`;
}

export const imagine: AppRouteHandler<ImagineDataRoute> = async (c) => {
  const logger: Logger = c.get("logger");
  const body = (await c.req.json()) as ImagineDataRequest;
  const startTime = performance.now();

  try {
    const response = await processSchema(body, logger, startTime);

    logger.info(
      { processingTime: response.metadata.processingTime },
      "Request completed",
    );
    return c.json(response, HttpStatusCodes.OK);
  } catch (error) {
    logger.error({ error }, "Error processing schema");
    captureException(error);
    return c.json(
      { error: "Failed to process schema" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};

import { getAllBlobs, getBlob } from "@/routes/ai/spell/behavior/effects.ts";
import { generateText } from "@/lib/llm.ts";
import { performSearch } from "@/routes/ai/spell/behavior/search.ts";
import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import {
  ProcessSchemaRequest,
  ProcessSchemaResponse,
} from "@/routes/ai/spell/spell.handlers.ts";
import {
  decomposeSchema,
  findExactMatches,
  findFragmentMatches,
  reassembleFragments,
  SchemaFragment,
} from "@/routes/ai/spell/schema.ts";

function calculateTagRank(
  data: Record<string, unknown>,
  tags: string[],
): number {
  if (!tags || tags.length === 0) return 0;

  const stringifiedData = JSON.stringify(data).toLowerCase();
  let rank = 0;

  for (const tag of tags) {
    if (stringifiedData.includes(tag.toLowerCase())) {
      rank++;
    }
  }

  return rank;
}

export async function processSchema(
  body: ProcessSchemaRequest,
  logger: Logger,
  startTime: number,
): Promise<ProcessSchemaResponse> {
  const tags = body.tags || [];
  logger.info(
    { schema: body.schema, many: body.many, options: body.options, tags },
    "Starting schema processing request",
  );

  // Get all blob keys first
  const allBlobs = await getAllBlobs({ allWithData: true });
  logger.info(
    { blobCount: allBlobs.length },
    "Retrieved blob keys from storage",
  );
  // Fetch all blob contents once
  const blobContents = new Map<string, Record<string, unknown>>();
  for (const [key, content] of Object.entries(allBlobs)) {
    blobContents.set(key, content as Record<string, unknown>);
  }
  logger.info(
    { loadedBlobCount: blobContents.size },
    "Loaded blob contents into memory",
  );

  let fragmentsWithMatches: SchemaFragment[];
  let reassembled: Record<string, unknown>;

  if (body.options?.exact) {
    // When exact matching, treat the entire schema as one fragment
    logger.debug("Using exact schema matching mode");
    const exactFragment: SchemaFragment = {
      path: [],
      schema: body.schema,
      matches: [],
    };

    const matches = findExactMatches(
      exactFragment.schema,
      blobContents,
      tags,
    );
    exactFragment.matches = matches;
    fragmentsWithMatches = [exactFragment];
    reassembled = {
      matches: matches.map((m) => m.data),
    };

    logger.info(
      { matchCount: matches.length },
      "Completed exact schema matching",
    );
  } else {
    // Normal decomposition mode
    logger.debug("Beginning schema decomposition");
    const fragments = decomposeSchema(body.schema);
    logger.info(
      {
        fragmentCount: fragments.length,
        fragmentPaths: fragments.map((f) => f.path.join(".")),
      },
      "Schema decomposed into fragments",
    );

    // Print each fragment
    fragments.forEach((fragment) => {
      logger.info({
        path: fragment.path.join("."),
        schema: fragment.schema,
      }, "Fragment details");
    });

    let totalMatches = 0;
    fragmentsWithMatches = await Promise.all(
      fragments.map(async (fragment) => {
        logger.debug(
          { fragmentPath: fragment.path.join(".") },
          "Processing fragment",
        );
        const matches = await findFragmentMatches(
          fragment,
          blobContents,
          logger,
          tags,
        );
        totalMatches += matches.length;
        return { ...fragment, matches };
      }),
    );

    logger.info(
      { totalMatches, fragmentCount: fragments.length },
      "Completed fragment matching",
    );

    logger.debug("Beginning fragment reassembly");
    reassembled = reassembleFragments(fragmentsWithMatches, body.schema);
    logger.info(
      { reassembled },
      "Fragments reassembled into complete object",
    );
  }

  logger.debug("Constructing prompt with reassembled examples");
  const prompt = constructSchemaPrompt(
    body.schema,
    [{ key: "reassembled", data: reassembled }],
    body.prompt,
    body.many,
  );

  logger.info({ prompt }, "Sending request to LLM");
  const llmStartTime = performance.now();
  const llmResponse = await generateText({
    model: "claude-3-5-sonnet",
    system: body.many
      ? "Return valid JSON array synthesized from real data from the database. Each object must match the schema exactly."
      : "Return a valid JSON object synthesized from real data from the database. Must match the schema exactly.",
    stream: false,
    messages: [{ role: "user", content: prompt }],
  });
  logger.info(
    { llmTime: Math.round(performance.now() - llmStartTime) },
    "Received LLM response",
  );

  let result: Record<string, unknown> | Array<Record<string, unknown>>;
  try {
    logger.debug("Parsing LLM response");
    result = JSON.parse(llmResponse);
    if (body.many && !Array.isArray(result)) {
      logger.debug("Converting single object to array for many=true");
      result = [result];
    }
    logger.info(
      {
        resultType: body.many ? "array" : "object",
        resultSize: body.many ? (result as Array<unknown>).length : 1,
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
      schemaFormat: body.options?.format || "json",
      fragments: fragmentsWithMatches,
      reassembledExample: reassembled,
      tagMatchInfo: {
        usedTags: tags,
        matchRanks: fragmentsWithMatches.map((f) => ({
          path: f.path.join("."),
          matches: f.matches.map((m) => ({
            key: m.key,
            rank: m.rank,
          })),
        })),
      },
    },
  };
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
      if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
        // Only truncate long string values
        sanitized[key] = value.substring(0, MAX_VALUE_LENGTH) +
          "... [truncated]";
      } else if (Array.isArray(value)) {
        // Recursively sanitize array elements
        sanitized[key] = value.map((item) =>
          typeof item === "object" && item !== null
            ? sanitizeObject(item as Record<string, unknown>)
            : item
        );
      } else if (typeof value === "object" && value !== null) {
        // Recursively sanitize nested objects
        sanitized[key] = sanitizeObject(value as Record<string, unknown>);
      } else {
        // Keep primitives as-is
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  const examplesStr = examples
    .map(({ key, data }) => {
      const sanitizedData = sanitizeObject(data);
      return `--- Example from "${key}" ---\n${
        JSON.stringify(
          sanitizedData,
          null,
          2,
        )
      }`;
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

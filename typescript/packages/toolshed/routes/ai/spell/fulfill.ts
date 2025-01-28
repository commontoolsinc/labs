import { getAllBlobs, getBlob } from "@/routes/ai/spell/behavior/effects.ts";
import { generateText } from "@/lib/llm.ts";
import { performSearch } from "@/routes/ai/spell/behavior/search.ts";
import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import {
  ProcessSchemaRequest,
  ProcessSchemaResponse,
} from "@/routes/ai/spell/spell.handlers.ts";

interface SchemaFragment {
  path: string[];
  schema: Record<string, unknown>;
  matches: Array<{
    key: string;
    data: Record<string, unknown>;
    similarity: number;
  }>;
}

export async function processSchema(
  body: ProcessSchemaRequest,
  logger: Logger,
  startTime: number,
): Promise<ProcessSchemaResponse> {
  logger.info(
    { schema: body.schema, many: body.many, options: body.options },
    "Starting schema processing request",
  );

  // Get all blob keys first
  const allBlobs = await getAllBlobs(true);
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

    const matches = await findExactMatches(exactFragment, blobContents, logger);
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
    },
  };
}
function decomposeSchema(
  schema: Record<string, unknown>,
  parentPath: string[] = [],
): SchemaFragment[] {
  const fragments: SchemaFragment[] = [];

  for (const [key, value] of Object.entries(schema)) {
    const currentPath = [...parentPath, key];

    if (isObject(value)) {
      // Handle array definitions
      if (
        (value as Record<string, unknown>).type === "array" &&
        isObject((value as Record<string, unknown>).items)
      ) {
        const itemSchema = (value as Record<string, unknown>).items as Record<
          string,
          unknown
        >;
        // Create a more permissive version of the items schema
        const permissiveItemSchema = {
          ...itemSchema,
          additionalProperties: true, // Allow additional properties
          required: (itemSchema as Record<string, unknown>).required || [], // Maintain required properties
        };

        fragments.push({
          path: [...currentPath, "items"],
          schema: permissiveItemSchema,
          matches: [],
        });

        // If the items schema has properties, recursively decompose those
        if (isObject((itemSchema as Record<string, unknown>).properties)) {
          fragments.push(...decomposeSchema(
            (itemSchema as Record<string, unknown>).properties as Record<
              string,
              unknown
            >,
            [...currentPath, "items", "properties"],
          ));
        }
      } // Handle regular objects
      else if (
        !("type" in value) ||
        isObject((value as Record<string, unknown>).properties)
      ) {
        const objectSchema = {
          ...(value as Record<string, unknown>),
          additionalProperties: true, // Allow additional properties
          required: (value as Record<string, unknown>).required || [], // Maintain required properties
        };

        fragments.push({
          path: currentPath,
          schema: { [key]: objectSchema },
          matches: [],
        });

        // Recursively decompose if it has properties
        if ((value as Record<string, unknown>).properties) {
          fragments.push(...decomposeSchema(
            (value as Record<string, unknown>).properties as Record<
              string,
              unknown
            >,
            [...currentPath, "properties"],
          ));
        }
      }
    }
  }

  // If no fragments were created (nothing to decompose),
  // return the original schema as a single fragment
  if (fragments.length === 0) {
    return [{
      path: [],
      schema: schema,
      matches: [],
    }];
  }

  return fragments;
}

function findExactMatches(
  fragment: SchemaFragment,
  blobContents: Map<string, Record<string, unknown>>,
  logger: Logger,
): Array<{ key: string; data: Record<string, unknown>; similarity: number }> {
  const matches: Array<
    { key: string; data: Record<string, unknown>; similarity: number }
  > = [];

  for (const [blobKey, blobData] of blobContents) {
    try {
      // For exact matching, check each subtree of the blob
      const subtreeMatches = findExactSubtreeMatches(blobData, fragment.schema);

      for (const matchData of subtreeMatches) {
        matches.push({
          key: blobKey,
          data: matchData,
          similarity: 1.0, // Exact matches have perfect similarity
        });
      }
    } catch (error) {
      logger.error(
        { error, blobKey },
        "Error during exact schema matching",
      );
    }
  }

  logger.info(
    {
      matchCount: matches.length,
      topMatch: matches[0]?.key,
    },
    "Completed exact matching",
  );

  return matches;
}

function findExactSubtreeMatches(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];

  // Check if current object matches
  if (checkSchemaMatch(data, schema)) {
    matches.push(data);
  }

  // Recursively check all object properties
  for (const value of Object.values(data)) {
    if (isObject(value)) {
      matches.push(...findExactSubtreeMatches(
        value as Record<string, unknown>,
        schema,
      ));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isObject(item)) {
          matches.push(...findExactSubtreeMatches(
            item as Record<string, unknown>,
            schema,
          ));
        }
      }
    }
  }

  return matches;
}

function findFragmentMatches(
  fragment: SchemaFragment,
  blobContents: Map<string, Record<string, unknown>>,
  logger: Logger,
): Array<{ key: string; data: Record<string, unknown>; similarity: number }> {
  const matches: Array<
    { key: string; data: Record<string, unknown>; similarity: number }
  > = [];

  logger.debug(
    { fragmentPath: fragment.path.join("."), schema: fragment.schema },
    "Starting fragment match search",
  );

  for (const [blobKey, blobData] of blobContents) {
    try {
      // For each blob, look for matching objects at any level
      const subtreeMatches = findMatchingObjectsInSubtree(
        blobData,
        fragment.schema,
      );

      for (const match of subtreeMatches) {
        matches.push({
          key: blobKey,
          data: match,
          similarity: 1.0,
        });
      }
    } catch (error) {
      logger.error({ error, blobKey }, "Error processing blob");
    }
  }
  logger.info(
    {
      fragmentPath: fragment.path.join("."),
      matchCount: matches.length,
      matches,
    },
    "Found matching objects",
  );

  return matches;
}

function findMatchingObjectsInSubtree(
  data: unknown,
  schema: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];

  if (isObject(data)) {
    // Check if current object matches using the provided schema
    if (checkSchemaMatch(data as Record<string, unknown>, schema)) {
      matches.push(data as Record<string, unknown>);
    }

    // Recursively check all properties
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (isObject(value)) {
        matches.push(...findMatchingObjectsInSubtree(value, schema));
      } else if (Array.isArray(value)) {
        for (const item of value) {
          matches.push(...findMatchingObjectsInSubtree(item, schema));
        }
      }
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      matches.push(...findMatchingObjectsInSubtree(item, schema));
    }
  }

  return matches;
}

function reassembleFragments(
  fragments: SchemaFragment[],
  originalSchema: Record<string, unknown>,
): Record<string, unknown> {
  const reassembled: Record<string, unknown> = {};

  for (const fragment of fragments) {
    if (fragment.matches.length > 0) {
      // Use all matches
      const matchData = fragment.matches.map((m) => m.data);
      if (matchData.length === 1) {
        setNestedValue(reassembled, fragment.path, matchData[0]);
      } else {
        setNestedValue(reassembled, fragment.path, matchData);
      }
    }
  }

  return reassembled;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function extractPathData(
  data: Record<string, unknown>,
  path: string[],
): Record<string, unknown> | null {
  let current: any = data;

  // Special handling for "items" in the path
  for (const key of path) {
    if (current === undefined || current === null) return null;

    if (key === "items" && Array.isArray(current)) {
      // Return the array items directly
      return current;
    }

    current = current[key];
  }

  return current;
}

function calculateSimilarity(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): number {
  // Implement similarity calculation logic
  // Could use structural similarity, field name matching, value type matching, etc.
  // Return a score between 0 and 1
  return 0.8; // Placeholder
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    current[key] = current[key] || {};
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
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

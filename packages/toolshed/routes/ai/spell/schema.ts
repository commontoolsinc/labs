import { checkSchemaMatch } from "@/lib/schema-match.ts";
import { Logger } from "@/lib/prefixed-logger.ts";
import { isObject } from "@commontools/utils/types";

export interface SchemaMatch<T = Record<string, unknown>> {
  key: string;
  data: T;
  similarity: number;
  tagScore?: number;
}

export interface SchemaFragment {
  path: string[];
  schema: Record<string, unknown>;
  matches: Array<{
    key: string;
    data: Record<string, unknown>;
    similarity: number;
    tagScore?: number;
  }>;
}

export function calculateTagScore(data: unknown, tags: string[]): number {
  if (!tags || tags.length === 0) return 0;

  const dataStr = JSON.stringify(data).toLowerCase();
  let score = 0;

  for (const tag of tags) {
    const regex = new RegExp(tag.toLowerCase(), "g");
    const matches = dataStr.match(regex);
    if (matches) {
      score += matches.length;
    }
  }

  return score;
}

export function findExactMatches(
  schema: Record<string, unknown>,
  data: Map<string, Record<string, unknown>>,
  tags: string[] = [],
): SchemaMatch[] {
  const matches: SchemaMatch[] = [];

  for (const [key, value] of data) {
    const subtreeMatches = findExactSubtreeMatches(value, schema);
    matches.push(...subtreeMatches.map((matchData) => {
      const tagScore = calculateTagScore(matchData, tags);
      return {
        key,
        data: matchData,
        similarity: 1.0 + (tagScore * 0.1),
        tagScore,
      };
    }));
  }

  return matches.sort((a, b) => b.similarity - a.similarity);
}

export function findExactSubtreeMatches(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const matches: Array<Record<string, unknown>> = [];

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

export function decomposeSchema(
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
        !("type" in (value as Record<string, unknown>)) ||
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

export function findFragmentMatches(
  fragment: SchemaFragment,
  blobContents: Map<string, Record<string, unknown>>,
  logger: Logger,
  tags: string[] = [],
): Array<
  {
    key: string;
    data: Record<string, unknown>;
    similarity: number;
    tagScore?: number;
  }
> {
  const matches: Array<
    {
      key: string;
      data: Record<string, unknown>;
      similarity: number;
      tagScore?: number;
    }
  > = [];

  logger.debug(
    { fragmentPath: fragment.path.join("."), schema: fragment.schema },
    "Starting fragment match search",
  );

  for (const [blobKey, blobData] of blobContents) {
    try {
      const subtreeMatches = findMatchingObjectsInSubtree(
        blobData,
        fragment.schema,
      );

      for (const match of subtreeMatches) {
        const tagScore = calculateTagScore(match, tags);
        matches.push({
          key: blobKey,
          data: match,
          similarity: 1.0 + (tagScore * 0.1),
          tagScore,
        });
      }
    } catch (error) {
      logger.error({ error, blobKey }, "Error processing blob");
    }
  }

  const sortedMatches = matches.sort((a, b) => b.similarity - a.similarity);

  logger.info(
    {
      fragmentPath: fragment.path.join("."),
      matchCount: sortedMatches.length,
      matches: sortedMatches,
    },
    "Found and ranked matching objects",
  );

  return sortedMatches;
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

export function reassembleFragments(
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

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function extractPathData(
  data: Record<string, unknown>,
  path: string[],
): Record<string, unknown> | null {
  let current = data;

  // Special handling for "items" in the path
  for (const key of path) {
    if (current === undefined || current === null) return null;

    if (key === "items" && Array.isArray(current)) {
      // Return the array items directly
      return current;
    }

    current = current[key] as Record<string, unknown>;
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
